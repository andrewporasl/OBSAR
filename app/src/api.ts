export type Kind = 'all' | 'image' | 'gif' | 'video'

export interface Item {
  id: number
  library_id: number
  path: string
  name: string
  kind: 'image' | 'gif' | 'video'
  size: number
  mtime: number
  width: number | null
  height: number | null
  duration: number | null
  caption: string
  ocr: string
  thumb: string
  preview: string | null
  score?: number
  vis?: number
  txt?: number
}

export interface LibraryProgress {
  pending: number
  done: number
  error: number
  total: number
  syncing: boolean
  paused: boolean
  exists: boolean
  current: string | null
}

export interface ModelProgress {
  state: 'missing' | 'downloading' | 'ready' | 'error'
  done: number
  total: number
  error: string | null
}

export interface Status {
  pending: number
  done: number
  error: number
  total: number
  queued: number
  current: string | null
  libraries: Record<string, LibraryProgress>
  models_loaded: boolean
  last_error: string | null
  captions: boolean
  models: Record<string, ModelProgress>
  sync_on_launch: boolean
  library_count: number
}

export interface LibraryStats {
  images: number
  gifs: number
  videos: number
  pending: number
  done: number
  error: number
  total: number
  media_bytes: number
  frames: number
  vector_bytes: number
  text_bytes: number
}

export interface Library extends Partial<LibraryProgress> {
  id: number
  path: string
  name: string
  added_at: number
  last_synced: number | null
  enabled: boolean
  exists: boolean
  watching: boolean
  stats: LibraryStats
}

export interface ModelInfo {
  name: string
  path: string
  bytes: number
  present: boolean
  enabled: boolean
}

export interface Storage {
  data_dir: string
  data_free: number | null
  db_bytes: number
  thumb_bytes: number
  preview_bytes: number
  runtime_bytes: number
  models_dir: string
  models_free: number | null
  models: ModelInfo[]
  models_bytes: number
  total_bytes: number
}

let base = ''
export function setBase(url: string) {
  base = url
}
export function url(path: string) {
  return base + path
}

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(base + path, init)
  if (!r.ok) {
    let msg = `${r.status}`
    try {
      const body = await r.json()
      msg = body.detail ?? body.error ?? JSON.stringify(body)
    } catch {}
    throw new Error(msg)
  }
  return r.json() as Promise<T>
}
const post = <T,>(path: string, body?: unknown) =>
  j<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })

export const api = {
  status: () => j<Status>('/status'),
  search: (q: string, kind: Kind, library: number | null, limit = 80, signal?: AbortSignal) =>
    j<{ items: Item[]; degraded: boolean }>(
      `/search?q=${encodeURIComponent(q)}&kind=${kind}&limit=${limit}${library ? `&library=${library}` : ''}`,
      { signal }
    ),
  similar: (id: number) => j<{ items: Item[] }>(`/similar/${id}`),
  reindex: (id: number) => post<{ ok: boolean }>(`/reindex/${id}`),
  rescan: () => post<{ ok: boolean }>('/rescan'),

  libraries: () => j<{ items: Library[] }>('/libraries'),
  addLibrary: (path: string) => post<Library>('/libraries', { path }),
  removeLibrary: (id: number, deleteData: boolean) =>
    j<{ ok: boolean; deleted_files: number }>(`/libraries/${id}?delete_data=${deleteData}`, { method: 'DELETE' }),
  resync: (id: number, full = false) => post<{ ok: boolean }>(`/libraries/${id}/resync?full=${full}`),
  pause: (id: number, paused: boolean) => post<{ ok: boolean }>(`/libraries/${id}/pause?paused=${paused}`),
  enable: (id: number, enabled: boolean) => post<{ ok: boolean }>(`/libraries/${id}/enable?enabled=${enabled}`),

  storage: () => j<Storage>('/storage'),
  clearPreviews: () => post<{ removed: number }>('/storage/clear_previews'),
  clearThumbs: () => post<{ removed: number }>('/storage/clear_thumbs'),
  settings: (patch: { sync_on_launch?: boolean; captions?: boolean }) => post<Status>('/settings', patch),
  downloadModels: (captions: boolean) => post<{ started: string[] }>('/models/download', { captions }),
  deleteCaptionModel: () => j<{ deleted: boolean }>('/models/caption', { method: 'DELETE' })
}

export function fmtBytes(b: number | null | undefined, digits = 1): string {
  if (b === null || b === undefined) return '—'
  if (b >= 1e9) return (b / 1e9).toFixed(digits) + ' GB'
  if (b >= 1e6) return (b / 1e6).toFixed(digits) + ' MB'
  if (b >= 1e3) return Math.round(b / 1e3) + ' KB'
  return b + ' B'
}
export function fmtDur(s: number | null) {
  if (!s) return ''
  const m = Math.floor(s / 60)
  const r = Math.round(s % 60)
  return m ? `${m}:${String(r).padStart(2, '0')}` : `${r}s`
}
export function fmtAgo(t: number | null) {
  if (!t) return 'never'
  const d = Date.now() / 1000 - t
  if (d < 60) return 'just now'
  if (d < 3600) return `${Math.round(d / 60)} min ago`
  if (d < 86400) return `${Math.round(d / 3600)} h ago`
  return `${Math.round(d / 86400)} d ago`
}
