import { contextBridge, ipcRenderer } from 'electron'

export interface BackendInfo {
  port: number
  url: string
  log: string[]
  packaged: boolean
  needsSetup: boolean
  settings: AppSettings
}

export interface AppSettings {
  dataDir?: string
  modelsDir?: string
  captions: boolean
  offline: boolean
  setupDone: boolean
  hotkey: boolean
  tray: boolean
}

export interface SetupEvent {
  step: 'python' | 'deps' | 'models' | 'done'
  state: 'running' | 'done' | 'error' | 'skipped'
  percent?: number
  line?: string
  error?: string
}

export interface DriveInfo {
  path: string
  free: number
  total: number
}

const on = <T,>(channel: string) => (cb: (v: T) => void) => {
  const h = (_: unknown, v: T) => cb(v)
  ipcRenderer.on(channel, h)
  return () => {
    ipcRenderer.removeListener(channel, h)
  }
}

const api = {
  backendInfo: () => ipcRenderer.invoke('backend:info') as Promise<BackendInfo>,
  restartBackend: () => ipcRenderer.invoke('backend:restart') as Promise<number>,
  setSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke('settings:set', patch) as Promise<AppSettings>,
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder') as Promise<string | null>,
  drives: () => ipcRenderer.invoke('disk:drives') as Promise<DriveInfo[]>,
  diskFree: (p: string) => ipcRenderer.invoke('disk:free', p) as Promise<number | null>,
  openPath: (p: string) => ipcRenderer.invoke('shell:openPath', p),
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
  runSetup: (opts: { dataDir: string; modelsDir: string; captions: boolean }) => ipcRenderer.invoke('setup:run', opts) as Promise<boolean>,
  cancelSetup: () => ipcRenderer.invoke('setup:cancel'),
  onSetup: on<SetupEvent>('setup:event'),

  dragOut: (files: string[], iconDataUrl?: string) => ipcRenderer.send('drag:start', { files, iconDataUrl }),
  reveal: (p: string) => ipcRenderer.invoke('file:reveal', p),
  open: (p: string) => ipcRenderer.invoke('file:open', p),
  copyPath: (p: string) => ipcRenderer.invoke('file:copyPath', p),
  copyText: (t: string) => ipcRenderer.invoke('file:copyText', t),
  copyImage: (p: string) => ipcRenderer.invoke('file:copyImage', p) as Promise<boolean>,
  contextMenu: (item: { path: string; id: number }) => ipcRenderer.invoke('ctx:item', item) as Promise<string | null>,
  onBackendLog: on<string>('backend-log'),
  onBackendExit: on<number | null>('backend-exit'),
  onFocusSearch: on<void>('focus-search'),
  onOpenSettings: on<void>('open-settings')
}

contextBridge.exposeInMainWorld('obsar', api)

export type ObsarApi = typeof api
