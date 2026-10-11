import { useEffect, useState } from 'react'
import { api, fmtAgo, fmtBytes, Library, Status, Storage } from '../api'
import type { AppSettings } from '../../electron/preload'

interface Props {
  status: Status | null
  libraries: Library[]
  storage: Storage | null
  settings: AppSettings
  log: string[]
  onClose: () => void
  onChanged: () => void
  onStorageRefresh: () => void
  onSettings: (patch: Partial<AppSettings>) => void
}

type Tab = 'libraries' | 'storage' | 'general'

export function SettingsPanel(p: Props) {
  const [tab, setTab] = useState<Tab>('libraries')
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Library | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    p.onStorageRefresh()
    const id = setInterval(p.onStorageRefresh, 5000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    setErr(null)
    try {
      await fn()
      p.onChanged()
      p.onStorageRefresh()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const addFolder = async () => {
    const dir = await window.obsar.pickFolder()
    if (dir) run('add', () => api.addLibrary(dir))
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div className="modal" role="dialog" aria-label="Settings">
        <div className="modal-head">
          <nav className="tabs">
            {(['libraries', 'storage', 'general'] as Tab[]).map((t) => (
              <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </nav>
          <button className="icon-btn" onClick={p.onClose} aria-label="Close">
            ×
          </button>
        </div>
        {err && <div className="error-line">{err}</div>}

        {tab === 'libraries' && (
          <div className="modal-body">
            <div className="row-between">
              <p className="muted">Each folder is indexed once, then watched. All libraries are re-synced when OBSAR starts.</p>
              <button className="primary" onClick={addFolder} disabled={busy === 'add'}>
                Add folder
              </button>
            </div>
            {p.libraries.length === 0 && <div className="empty-card">No libraries yet. Add the folder where your memes, clips and screenshots live.</div>}
            {p.libraries.map((lib) => {
              const live = p.status?.libraries[String(lib.id)]
              const s = lib.stats
              const syncing = live?.syncing && s.pending > 0
              const pct = s.total ? Math.round((s.done / s.total) * 100) : 0
              let state = 'Synced'
              if (!lib.enabled) state = 'Removed (index kept)'
              else if (!lib.exists) state = 'Folder not found'
              else if (live?.paused) state = 'Paused'
              else if (syncing) state = `Syncing ${s.done.toLocaleString()} of ${s.total.toLocaleString()}`
              return (
                <div key={lib.id} className={'card lib' + (lib.enabled ? '' : ' off')}>
                  <div className="card-main">
                    <div className="card-title">
                      <span className="name">{lib.name}</span>
                      <span className={'pill' + (syncing ? ' live' : !lib.exists && lib.enabled ? ' bad' : '')}>{state}</span>
                    </div>
                    <div className="path" title={lib.path}>
                      {lib.path}
                    </div>
                    <div className="facts">
                      <span>{s.images.toLocaleString()} images</span>
                      <span>{s.gifs.toLocaleString()} GIFs</span>
                      <span>{s.videos.toLocaleString()} videos</span>
                      <span>{fmtBytes(s.media_bytes)} of media</span>
                      <span>index {fmtBytes(s.vector_bytes + s.text_bytes)}</span>
                      <span>synced {fmtAgo(lib.last_synced)}</span>
                      {s.error > 0 && <span className="bad">{s.error} failed</span>}
                    </div>
                    {syncing && (
                      <div className="bar">
                        <div style={{ width: pct + '%' }} />
                      </div>
                    )}
                  </div>
                  <div className="card-actions">
                    {lib.enabled ? (
                      <>
                        <button onClick={() => run(`resync${lib.id}`, () => api.resync(lib.id))} disabled={!!busy} title="Scan for new, changed and deleted files">
                          Resync
                        </button>
                        <button onClick={() => run(`full${lib.id}`, () => api.resync(lib.id, true))} disabled={!!busy} title="Re-run captions and embeddings on every file">
                          Rebuild
                        </button>
                        <button onClick={() => run(`pause${lib.id}`, () => api.pause(lib.id, !live?.paused))} disabled={!!busy}>
                          {live?.paused ? 'Resume' : 'Pause'}
                        </button>
                        <button className="danger" onClick={() => setConfirm(lib)} disabled={!!busy}>
                          Remove
                        </button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => run(`en${lib.id}`, () => api.enable(lib.id, true))} disabled={!!busy}>
                          Re-add
                        </button>
                        <button className="danger" onClick={() => run(`del${lib.id}`, () => api.removeLibrary(lib.id, true))} disabled={!!busy}>
                          Delete index
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'storage' && p.storage && <StorageTab storage={p.storage} status={p.status} run={run} busy={busy} settings={p.settings} onSettings={p.onSettings} />}
        {tab === 'storage' && !p.storage && <div className="modal-body muted">Measuring…</div>}

        {tab === 'general' && (
          <div className="modal-body">
            <Toggle
              label="Re-sync all libraries when OBSAR starts"
              hint="Catches files that changed while the app was closed. Recommended."
              value={p.status?.sync_on_launch ?? true}
              onChange={(v) => run('sync', () => api.settings({ sync_on_launch: v }))}
            />
            <Toggle
              label="Captions and text recognition"
              hint="Uses the 8 GB Qwen2.5-VL model to describe each file and read any text in it. Turn off for visual-only search and faster indexing."
              value={p.status?.captions ?? true}
              onChange={(v) => {
                p.onSettings({ captions: v })
                run('captions', () => api.settings({ captions: v }))
              }}
            />
            <Toggle
              label="Global shortcut  Ctrl+Shift+Space"
              hint="Summon the window from any app."
              value={p.settings.hotkey}
              onChange={(v) => p.onSettings({ hotkey: v })}
            />
            <Toggle label="Keep running in the tray when the window is closed" hint="Needed for the shortcut to work while the window is closed." value={p.settings.tray} onChange={(v) => p.onSettings({ tray: v })} />
            <Toggle
              label="Offline mode"
              hint="Never contact the internet. Models must already be downloaded."
              value={p.settings.offline}
              onChange={(v) => p.onSettings({ offline: v })}
            />
            <details className="log-details">
              <summary>Backend log</summary>
              <pre className="log">{p.log.slice(-200).join('\n')}</pre>
            </details>
          </div>
        )}

        {confirm && (
          <div className="confirm">
            <div className="confirm-box">
              <h3>Remove “{confirm.name}”?</h3>
              <p>OBSAR stops watching this folder and hides it from search. Your files are never touched.</p>
              <p className="muted">
                Keeping the index ({fmtBytes(confirm.stats.vector_bytes + confirm.stats.text_bytes)}) makes re-adding instant. Deleting it means every file is captioned again if you add the folder back.
              </p>
              <div className="confirm-actions">
                <button onClick={() => setConfirm(null)}>Cancel</button>
                <button
                  onClick={() => {
                    const l = confirm
                    setConfirm(null)
                    run('rm', () => api.removeLibrary(l.id, false))
                  }}
                >
                  Remove, keep index
                </button>
                <button
                  className="danger"
                  onClick={() => {
                    const l = confirm
                    setConfirm(null)
                    run('rm', () => api.removeLibrary(l.id, true))
                  }}
                >
                  Remove and delete index
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Toggle({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle">
      <div>
        <div className="toggle-label">{label}</div>
        {hint && <div className="muted small">{hint}</div>}
      </div>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch" />
    </label>
  )
}

function StorageTab({
  storage: s,
  status,
  run,
  busy,
  settings,
  onSettings
}: {
  storage: Storage
  status: Status | null
  run: (k: string, fn: () => Promise<unknown>) => Promise<void>
  busy: string | null
  settings: AppSettings
  onSettings: (patch: Partial<AppSettings>) => void
}) {
  const caption = s.models.find((m) => m.name.toLowerCase().includes('qwen'))
  const embed = s.models.find((m) => !m.name.toLowerCase().includes('qwen'))
  const dl = status ? Object.entries(status.models).find(([, m]) => m.state === 'downloading') : undefined
  const parts: [string, number][] = [
    ['Models', s.models_bytes],
    ['Index database', s.db_bytes],
    ['Thumbnails', s.thumb_bytes],
    ['Hover previews', s.preview_bytes],
    ...(s.runtime_bytes ? ([['Python runtime', s.runtime_bytes]] as [string, number][]) : [])
  ]
  return (
    <div className="modal-body">
      <div className="total">
        <div className="total-num">{fmtBytes(s.total_bytes, 2)}</div>
        <div className="total-label">used by OBSAR in total</div>
        <div className="stack">
          {parts.map(([k, v]) => (
            <span key={k} style={{ flexGrow: Math.max(v, s.total_bytes / 200) }} title={`${k}: ${fmtBytes(v)}`} data-k={k} />
          ))}
        </div>
        <div className="legend">
          {parts.map(([k, v]) => (
            <span key={k}>
              <i data-k={k} /> {k} <b>{fmtBytes(v)}</b>
            </span>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-main">
          <div className="card-title">
            <span className="name">Models</span>
            <span className="pill">{fmtBytes(s.models_bytes)}</span>
          </div>
          <div className="path" title={s.models_dir}>
            {s.models_dir}
          </div>
          <div className="facts">
            <span>{fmtBytes(s.models_free)} free on this drive</span>
          </div>
          <ul className="models">
            {embed && (
              <li>
                <span>Visual search · {embed.name}</span>
                <b>{embed.present ? fmtBytes(embed.bytes) : 'not downloaded'}</b>
              </li>
            )}
            {caption && (
              <li>
                <span>Captions &amp; text · {caption.name}</span>
                <b>
                  {dl && dl[0] === caption.name
                    ? `${fmtBytes(dl[1].done)} / ${fmtBytes(dl[1].total)}`
                    : caption.present
                      ? fmtBytes(caption.bytes) + (caption.enabled ? '' : ' (off)')
                      : 'not downloaded'}
                </b>
              </li>
            )}
          </ul>
        </div>
        <div className="card-actions">
          <button onClick={() => window.obsar.openPath(s.models_dir)}>Open folder</button>
          {caption && caption.present && (
            <button className="danger" onClick={() => run('delcap', () => api.deleteCaptionModel())} disabled={!!busy} title="Frees ~8 GB; search becomes visual-only">
              Delete caption model
            </button>
          )}
          {caption && !caption.present && !dl && (
            <button
              onClick={() => {
                onSettings({ captions: true })
                run('dlcap', () => api.downloadModels(true))
              }}
              disabled={!!busy}
            >
              Download caption model
            </button>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-main">
          <div className="card-title">
            <span className="name">Index &amp; thumbnails</span>
            <span className="pill">{fmtBytes(s.db_bytes + s.thumb_bytes + s.preview_bytes)}</span>
          </div>
          <div className="path" title={s.data_dir}>
            {s.data_dir}
          </div>
          <div className="facts">
            <span>database {fmtBytes(s.db_bytes)}</span>
            <span>thumbnails {fmtBytes(s.thumb_bytes)}</span>
            <span>previews {fmtBytes(s.preview_bytes)}</span>
            <span>{fmtBytes(s.data_free)} free on this drive</span>
          </div>
        </div>
        <div className="card-actions">
          <button onClick={() => window.obsar.openPath(s.data_dir)}>Open folder</button>
          <button onClick={() => run('prev', () => api.clearPreviews())} disabled={!!busy} title="Previews are rebuilt the next time you hover a GIF or video">
            Clear previews
          </button>
        </div>
      </div>
      {settings.dataDir === undefined && <p className="muted small">Locations are set in the development <code>backend/.env</code>. The installed app chooses them during setup.</p>}
    </div>
  )
}
