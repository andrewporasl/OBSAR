import { fmtBytes, Status } from '../api'
import type { UpdateEvent } from '../../electron/preload'

interface Props {
  status: Status | null
  down: boolean
  degraded: boolean
  selectedCount: number
  update: UpdateEvent
  onSettings: () => void
  onRestart: () => void
}

function modelLine(status: Status): string | null {
  const dl = Object.entries(status.models).find(([, m]) => m.state === 'downloading')
  if (dl) {
    const [name, m] = dl
    const short = name.split('/').pop()
    return m.total ? `Downloading ${short} · ${fmtBytes(m.done)} of ${fmtBytes(m.total)}` : `Downloading ${short}…`
  }
  const err = Object.entries(status.models).find(([, m]) => m.state === 'error')
  if (err) return `Model download failed: ${err[1].error}`
  return null
}

export function StatusBar({ status, down, degraded, selectedCount, update, onSettings, onRestart }: Props) {
  let text: React.ReactNode
  let percent: number | null = null
  if (down) {
    text = (
      <span className="err">
        Backend stopped.{' '}
        <button className="link" onClick={onRestart}>
          Restart
        </button>
      </span>
    )
  } else if (!status) {
    text = 'Starting…'
  } else if (!status.models_loaded) {
    const dl = Object.values(status.models).find((m) => m.state === 'downloading')
    if (dl && dl.total) percent = Math.min(100, (dl.done / dl.total) * 100)
    text = modelLine(status) ?? (status.last_error ? `Error: ${status.last_error}` : 'Loading models…')
  } else if (status.pending > 0 || status.queued > 0) {
    percent = status.total ? (status.done / status.total) * 100 : 0
    text = `Syncing ${status.done.toLocaleString()} of ${status.total.toLocaleString()}${status.current ? ` · ${status.current}` : ''}`
  } else if (status.library_count === 0) {
    text = 'No libraries yet'
  } else {
    text = `${status.total.toLocaleString()} files · ${status.library_count} ${status.library_count === 1 ? 'library' : 'libraries'} · watching for changes${status.error ? ` · ${status.error} failed` : ''}`
  }

  let updateNode: React.ReactNode = null
  if (update.state === 'downloading') updateNode = <span className="muted">Downloading update {Math.round(update.percent ?? 0)}%</span>
  else if (update.state === 'ready')
    updateNode = (
      <span className="update-ready">
        Update {update.version} ready ·{' '}
        <button className="link" onClick={() => window.obsar.installUpdate()}>
          Restart to update
        </button>
      </span>
    )

  return (
    <footer className="status">
      {percent !== null && <div className="progress" style={{ width: `${Math.max(1, percent)}%` }} />}
      <span className="status-text">{text}</span>
      <span className="spacer" />
      {degraded && <span className="warn">text-only results until models load</span>}
      {updateNode}
      {selectedCount > 1 && <span className="muted">{selectedCount} selected</span>}
      <button className="icon-btn" onClick={onSettings} title="Settings (Ctrl+,)" aria-label="Settings">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
          <path
            d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zm7.4-2.6.1-.9-.1-.9 2-1.6-1.9-3.3-2.4 1a7 7 0 0 0-1.6-.9L15 3.9H9l-.5 2.4a7 7 0 0 0-1.6.9l-2.4-1L2.6 9.5l2 1.6-.1.9.1.9-2 1.6 1.9 3.3 2.4-1c.5.4 1 .7 1.6.9l.5 2.4h6l.5-2.4c.6-.2 1.1-.5 1.6-.9l2.4 1 1.9-3.3-2-1.6z"
            fill="currentColor"
          />
        </svg>
      </button>
    </footer>
  )
}
