/** Auto-update from GitHub Releases via electron-updater. No-op in development. */
import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateEvent } from './preload'

let started = false
let timer: NodeJS.Timeout | null = null
let last: UpdateEvent = { state: 'idle' }

function emit(ev: UpdateEvent, log?: (l: string) => void) {
  last = ev
  log?.(`[update] ${ev.state}${ev.version ? ' ' + ev.version : ''}${ev.error ? ' ' + ev.error : ''}`)
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('update:event', ev)
}

export function lastUpdateEvent(): UpdateEvent {
  return last
}

export function startUpdater(opts: { offline: () => boolean; log: (l: string) => void }) {
  if (!app.isPackaged || started) return
  started = true
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null

  autoUpdater.on('checking-for-update', () => emit({ state: 'checking' }, opts.log))
  autoUpdater.on('update-available', (i) => emit({ state: 'available', version: i.version }, opts.log))
  autoUpdater.on('update-not-available', () => emit({ state: 'none' }, opts.log))
  autoUpdater.on('download-progress', (p) => emit({ state: 'downloading', percent: p.percent }, opts.log))
  autoUpdater.on('update-downloaded', (i) => emit({ state: 'ready', version: i.version }, opts.log))
  autoUpdater.on('error', (e) => emit({ state: 'error', error: String(e?.message ?? e).slice(0, 200) }, opts.log))

  const check = () => {
    if (opts.offline()) return
    autoUpdater.checkForUpdates().catch(() => {})
  }
  setTimeout(check, 15_000)
  timer = setInterval(check, 6 * 60 * 60 * 1000)
}

export function checkNow(): Promise<void> {
  if (!app.isPackaged) {
    emit({ state: 'none' })
    return Promise.resolve()
  }
  return autoUpdater.checkForUpdates().then(() => undefined).catch(() => undefined)
}

export function installNow() {
  if (timer) clearInterval(timer)
  autoUpdater.quitAndInstall(false, true)
}
