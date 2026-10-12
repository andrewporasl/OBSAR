import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, session, shell, Tray } from 'electron'
import { spawn, ChildProcess, execFile } from 'child_process'
import { existsSync } from 'fs'
import { createServer } from 'net'
import { join, resolve } from 'path'
import Store from 'electron-store'
import type { AppSettings, SetupEvent } from './preload'
import { SetupCancelled, SetupRunner } from './setup'
import { checkNow, installNow, lastUpdateEvent, startUpdater } from './updater'
import { initLog, logDir, write as logWrite } from './log'
import { readFileSync } from 'fs'

const isDev = !app.isPackaged
if (process.env['OBSAR_CDP_PORT']) app.commandLine.appendSwitch('remote-debugging-port', process.env['OBSAR_CDP_PORT'])

const store = new Store<AppSettings>({
  defaults: { captions: true, offline: false, setupDone: false, hotkey: true, tray: true }
})

let win: BrowserWindow | null = null
let tray: Tray | null = null
let backend: ChildProcess | null = null
let backendPort = 0
let backendLog: string[] = []
let quitting = false
let setup: SetupRunner | null = null
let backendStartedAt = 0
let lastAutoRestart = 0

// ---- single instance -------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
}

function pushLog(line: string) {
  if (isDev) console.log(line)
  logWrite(line)
  backendLog.push(line)
  if (backendLog.length > 400) backendLog.shift()
  win?.webContents.send('backend-log', line)
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => res(port))
    })
    srv.on('error', rej)
  })
}

// ---- paths -----------------------------------------------------------------
function backendDir(): string {
  return isDev ? resolve(__dirname, '../../../backend') : join(process.resourcesPath, 'backend')
}
function uvPath(): string {
  const bundled = isDev ? resolve(__dirname, '../../resources/bin/uv.exe') : join(process.resourcesPath, 'bin', 'uv.exe')
  return existsSync(bundled) ? bundled : 'uv'
}
function pythonPath(): string {
  const dataDir = store.get('dataDir')
  if (!isDev && dataDir) {
    const p = join(dataDir, 'venv', 'Scripts', 'python.exe')
    if (existsSync(p)) return p
  }
  const venv = join(backendDir(), '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  return existsSync(venv) ? venv : process.platform === 'win32' ? 'python' : 'python3'
}
/** Tell the uninstaller where the big folders are (it cannot read the JSON config). */
function writeDirsFile() {
  try {
    const fs = require('fs') as typeof import('fs')
    const dir = join(app.getPath('appData'), 'obsar')
    fs.mkdirSync(dir, { recursive: true })
    const d = store.get('dataDir')
    const m = store.get('modelsDir')
    if (d) fs.writeFileSync(join(dir, 'dirs.txt'), `${d}

${m ?? ''}

`)
  } catch {}
}

function needsSetup(): boolean {
  if (isDev) return process.env['OBSAR_FORCE_SETUP'] === '1' && !store.get('setupDone') // dev aid: preview the wizard
  return !store.get('setupDone') || !existsSync(pythonPath())
}

// ---- backend process -----------------------------------------------------------
async function startBackend(): Promise<void> {
  if (backend) return
  if (needsSetup()) return
  backendPort = await freePort()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    HF_HUB_DISABLE_PROGRESS_BARS: '1',
    OBSAR_CAPTIONS: store.get('captions') === false ? '0' : '1'
  }
  const dataDir = store.get('dataDir')
  const modelsDir = store.get('modelsDir')
  if (dataDir) env['OBSAR_DATA_DIR'] = dataDir
  if (modelsDir) env['HF_HOME'] = modelsDir
  if (store.get('offline')) env['HF_HUB_OFFLINE'] = '1'
  const args = ['-m', 'obsar.main', '--port', String(backendPort)]
  const py = pythonPath()
  pushLog(`[obsar] starting backend: ${py} ${args.join(' ')} (cwd ${backendDir()})`)
  backend = spawn(py, args, { cwd: backendDir(), env, windowsHide: true })
  backend.stdout?.on('data', (d) => d.toString().split(/\r?\n/).filter(Boolean).forEach(pushLog))
  backend.stderr?.on('data', (d) => d.toString().split(/\r?\n/).filter(Boolean).forEach(pushLog))
  backendStartedAt = Date.now()
  win?.webContents.send('backend-started', backendPort)
  backend.on('exit', (code) => {
    pushLog(`[obsar] backend exited with code ${code}`)
    backend = null
    if (quitting) return
    // crashed: restart automatically, but at most once per 5 minutes so a crash loop reaches the user
    if (code !== 0 && Date.now() - lastAutoRestart > 5 * 60_000) {
      lastAutoRestart = Date.now()
      pushLog('[obsar] restarting backend automatically')
      setTimeout(() => startBackend(), 1500)
      return
    }
    win?.webContents.send('backend-exit', code)
  })
}

function stopBackend() {
  if (!backend) return
  try {
    if (process.platform === 'win32' && backend.pid) spawn('taskkill', ['/pid', String(backend.pid), '/f', '/t'], { windowsHide: true })
    else backend.kill('SIGTERM')
  } catch {}
  backend = null
}

async function waitForBackend(timeoutMs = 120_000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${backendPort}/status`)
      if (r.ok) return true
    } catch {}
    if (!backend) return false
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

// ---- window ----------------------------------------------------------------
function savedBounds(): Partial<Electron.Rectangle> {
  const b = store.get('bounds')
  if (!b) return {}
  const { screen } = require('electron') as typeof import('electron')
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea
    return b.x + 100 < a.x + a.width && b.x + b.width - 100 > a.x && b.y + 50 < a.y + a.height && b.y + 50 > a.y
  })
  return visible ? b : { width: b.width, height: b.height }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    ...savedBounds(),
    minWidth: 760,
    minHeight: 520,
    backgroundColor: '#0e0f12',
    title: 'OBSAR',
    autoHideMenuBar: true,
    icon: isDev ? resolve(__dirname, '../../build/icon.png') : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  if (isDev && process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(join(__dirname, '../renderer/index.html'))

  if (isDev) {
    win.webContents.on('console-message', (_e, level, message, line, source) => {
      if (level >= 2) console.log(`[renderer] ${message} (${source}:${line})`)
    })
    win.webContents.on('did-fail-load', (_e, code, desc, url) => console.log(`[renderer] failed to load ${url}: ${code} ${desc}`))
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  win.on('close', (e) => {
    if (!quitting && store.get('tray') && tray) {
      e.preventDefault()
      win?.hide()
    }
  })
  if (store.get('maximized')) win.maximize()
  let saveTimer: NodeJS.Timeout | null = null
  const saveState = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      if (!win) return
      store.set('maximized', win.isMaximized())
      if (!win.isMaximized() && !win.isMinimized()) store.set('bounds', win.getBounds())
    }, 400)
  }
  win.on('resize', saveState)
  win.on('move', saveState)
  win.on('maximize', saveState)
  win.on('unmaximize', saveState)
  win.on('closed', () => (win = null))
}

function showWindow() {
  if (!win) createWindow()
  else {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
}

function installCsp() {
  if (isDev) return
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' http://127.0.0.1:* data: blob:; connect-src 'self' http://127.0.0.1:*; font-src 'self'"
        ]
      }
    })
  })
}

function trayIcon(): Electron.NativeImage {
  const p = isDev ? resolve(__dirname, '../../build/icon.png') : join(process.resourcesPath, 'icon.png')
  const img = existsSync(p) ? nativeImage.createFromPath(p) : nativeImage.createEmpty()
  return img.isEmpty() ? img : img.resize({ width: 16, height: 16 })
}

function setupTray() {
  if (tray || !store.get('tray')) return
  try {
    const icon = trayIcon()
    if (icon.isEmpty()) return
    tray = new Tray(icon)
    tray.setToolTip('OBSAR')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Show OBSAR', click: showWindow },
        {
          label: 'Settings',
          click: () => {
            showWindow()
            win?.webContents.send('open-settings')
          }
        },
        { type: 'separator' },
        {
          label: 'Quit',
          click: () => {
            quitting = true
            app.quit()
          }
        }
      ])
    )
    tray.on('click', showWindow)
  } catch {
    tray = null
  }
}

function applyHotkey() {
  globalShortcut.unregisterAll()
  if (!store.get('hotkey')) return
  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    showWindow()
    win?.webContents.send('focus-search')
  })
}

// ---- IPC: info / settings ----------------------------------------------------
ipcMain.handle('backend:info', () => ({
  port: backendPort,
  url: `http://127.0.0.1:${backendPort}`,
  log: backendLog,
  packaged: !isDev,
  needsSetup: needsSetup(),
  settings: store.store,
  version: app.getVersion()
}))

ipcMain.handle('app:about', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: `${process.platform} ${process.arch}`,
  dataDir: store.get('dataDir') ?? null,
  modelsDir: store.get('modelsDir') ?? null,
  logDir: logDir(),
  packaged: !isDev
}))

ipcMain.handle('app:changelog', () => {
  const p = isDev ? resolve(__dirname, '../../../CHANGELOG.md') : join(process.resourcesPath, 'CHANGELOG.md')
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
})

ipcMain.handle('gpu:info', () => {
  return new Promise<{ name: string; vramMb: number } | null>((res) => {
    execFile('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 5000 }, (err, out) => {
      if (err || !out) return res(null)
      const line = out.split(/\r?\n/).find(Boolean)
      if (!line) return res(null)
      const [name, mem] = line.split(',').map((s) => s.trim())
      res({ name, vramMb: Number(mem) || 0 })
    })
  })
})

ipcMain.handle('update:check', async () => {
  await checkNow()
  return lastUpdateEvent()
})
ipcMain.handle('update:install', () => {
  quitting = true
  stopBackend()
  installNow()
})
ipcMain.handle('shell:openExternal', (_e, url: string) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url)
})

ipcMain.handle('backend:restart', async () => {
  stopBackend()
  await new Promise((r) => setTimeout(r, 400))
  await startBackend()
  return backendPort
})

ipcMain.handle('settings:set', async (_e, patch: Partial<AppSettings>) => {
  const before = { ...store.store }
  for (const [k, v] of Object.entries(patch)) store.set(k as keyof AppSettings, v as never)
  if ('dataDir' in patch || 'modelsDir' in patch) writeDirsFile()
  if ('hotkey' in patch) applyHotkey()
  if ('tray' in patch) {
    if (patch.tray) setupTray()
    else {
      tray?.destroy()
      tray = null
    }
  }
  const restart =
    ('offline' in patch && patch.offline !== before.offline) ||
    ('dataDir' in patch && patch.dataDir !== before.dataDir) ||
    ('modelsDir' in patch && patch.modelsDir !== before.modelsDir)
  if (restart) {
    stopBackend()
    await new Promise((r) => setTimeout(r, 400))
    await startBackend()
  }
  return store.store
})

ipcMain.handle('dialog:pickFolder', async () => {
  const res = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] })
  return res.canceled || !res.filePaths[0] ? null : res.filePaths[0]
})

ipcMain.handle('shell:openPath', (_e, p: string) => shell.openPath(p))
ipcMain.handle('app:relaunch', () => {
  quitting = true
  app.relaunch()
  app.quit()
})

// ---- IPC: disks ---------------------------------------------------------------
function listDrives(): Promise<{ path: string; free: number; total: number }[]> {
  return new Promise((res) => {
    if (process.platform !== 'win32') return res([{ path: '/', free: 0, total: 0 }])
    execFile(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -ne $null } | ForEach-Object { '{0}|{1}|{2}' -f $_.Root, $_.Free, ($_.Used + $_.Free) }"
      ],
      { windowsHide: true },
      (err, out) => {
        if (err) return res([])
        res(
          out
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)
            .map((l) => {
              const [p, f, t] = l.split('|')
              return { path: p, free: Number(f), total: Number(t) }
            })
            .filter((d) => d.total > 0)
        )
      }
    )
  })
}
ipcMain.handle('disk:drives', () => listDrives())
ipcMain.handle('disk:free', async (_e, p: string) => {
  const drives = await listDrives()
  const d = drives.find((d) => p.toUpperCase().startsWith(d.path.toUpperCase().slice(0, 2)))
  return d ? d.free : null
})

// ---- IPC: first-run setup -----------------------------------------------------
ipcMain.handle('setup:run', async (_e, opts: { dataDir: string; modelsDir: string; captions: boolean }) => {
  const emit = (ev: SetupEvent) => win?.webContents.send('setup:event', ev)
  store.set('dataDir', opts.dataDir)
  store.set('modelsDir', opts.modelsDir)
  store.set('captions', opts.captions)
  setup = new SetupRunner({ uv: uvPath(), backendDir: backendDir(), dataDir: opts.dataDir, modelsDir: opts.modelsDir }, emit)
  try {
    if (isDev) {
      emit({ step: 'python', state: 'skipped', line: 'dev mode: using backend/.venv' })
      emit({ step: 'deps', state: 'skipped' })
    } else {
      await setup.installRuntime()
    }
    // step 3: models, through the backend
    store.set('setupDone', true) // lets startBackend proceed; reverted on failure
    writeDirsFile()
    stopBackend()
    await startBackend()
    emit({ step: 'models', state: 'running', line: 'starting backend' })
    if (!(await waitForBackend())) throw new Error('backend did not start; see log')
    const base = `http://127.0.0.1:${backendPort}`
    await fetch(`${base}/models/download`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ captions: opts.captions })
    })
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000))
      const st = (await (await fetch(`${base}/status`)).json()) as {
        models: Record<string, { state: string; done: number; total: number; error: string | null }>
        models_loaded: boolean
      }
      const models = Object.values(st.models)
      const err = models.find((m) => m.state === 'error')
      if (err) throw new Error(err.error ?? 'download failed')
      const dl = models.find((m) => m.state === 'downloading')
      if (dl) {
        emit({
          step: 'models',
          state: 'running',
          percent: dl.total ? Math.min(100, (dl.done / dl.total) * 100) : undefined,
          line: dl.total ? `${(dl.done / 1e6).toFixed(0)} / ${(dl.total / 1e6).toFixed(0)} MB` : undefined
        })
        continue
      }
      if (st.models_loaded) break
    }
    emit({ step: 'models', state: 'done', percent: 100 })
    emit({ step: 'done', state: 'done' })
    return true
  } catch (e) {
    store.set('setupDone', false)
    if (!(e instanceof SetupCancelled)) emit({ step: 'models', state: 'error', error: (e as Error).message })
    return false
  } finally {
    setup = null
  }
})
ipcMain.handle('setup:cancel', () => {
  setup?.cancel()
  stopBackend()
})

// ---- IPC: files ---------------------------------------------------------------
ipcMain.on('drag:start', (event, payload: { files: string[]; iconDataUrl?: string }) => {
  const files = payload.files.filter((f) => existsSync(f))
  if (!files.length) return
  let icon = nativeImage.createEmpty()
  try {
    if (payload.iconDataUrl) icon = nativeImage.createFromDataURL(payload.iconDataUrl)
  } catch {}
  if (icon.isEmpty()) {
    icon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
    )
  }
  if (files.length === 1) event.sender.startDrag({ file: files[0], icon })
  else event.sender.startDrag({ file: files[0], files, icon })
})

ipcMain.handle('file:reveal', (_e, p: string) => shell.showItemInFolder(p))
ipcMain.handle('file:open', (_e, p: string) => shell.openPath(p))
ipcMain.handle('file:copyPath', (_e, p: string) => clipboard.writeText(p))
ipcMain.handle('file:copyText', (_e, t: string) => clipboard.writeText(t))
ipcMain.handle('file:copyImage', async (_e, p: string) => {
  const img = nativeImage.createFromPath(p)
  if (img.isEmpty()) return false
  clipboard.writeImage(img)
  return true
})

ipcMain.handle('ctx:item', async () => {
  return new Promise<string | null>((resolve) => {
    const menu = Menu.buildFromTemplate([
      { label: 'Open', click: () => resolve('open') },
      { label: 'Reveal in Explorer', click: () => resolve('reveal') },
      { type: 'separator' },
      { label: 'Copy image', click: () => resolve('copyImage') },
      { label: 'Copy path', click: () => resolve('copyPath') },
      { type: 'separator' },
      { label: 'Find similar', click: () => resolve('similar') },
      { label: 'Re-index this file', click: () => resolve('reindex') }
    ])
    menu.popup({ window: win!, callback: () => setTimeout(() => resolve(null), 50) })
  })
})

// ---- lifecycle -----------------------------------------------------------------
app.whenReady().then(async () => {
  initLog(store.get('dataDir') ?? app.getPath('userData'))
  logWrite(`[obsar] v${app.getVersion()} packaged=${!isDev}`)
  installCsp()
  await startBackend()
  startUpdater({ offline: () => !!store.get('offline'), log: pushLog })
  createWindow()
  setupTray()
  applyHotkey()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !(store.get('tray') && tray)) app.quit()
})
app.on('before-quit', () => {
  quitting = true
  stopBackend()
})
app.on('will-quit', () => globalShortcut.unregisterAll())
