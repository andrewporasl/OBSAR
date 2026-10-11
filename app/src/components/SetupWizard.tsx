import { useEffect, useState } from 'react'
import { fmtBytes } from '../api'
import type { DriveInfo, SetupEvent } from '../../electron/preload'
import { Logo } from './Logo'

const NEED_BASE = 6.5e9 // python + torch
const NEED_EMBED = 4.6e9
const NEED_CAPTION = 8.2e9

interface Props {
  onDone: () => void
}

type StepState = { state: SetupEvent['state'] | 'pending'; percent?: number; lines: string[]; error?: string }

export function SetupWizard({ onDone }: Props) {
  const [drives, setDrives] = useState<DriveInfo[]>([])
  const [dir, setDir] = useState('')
  const [captions, setCaptions] = useState(true)
  const [phase, setPhase] = useState<'choose' | 'install' | 'finish'>('choose')
  const [steps, setSteps] = useState<Record<string, StepState>>({
    python: { state: 'pending', lines: [] },
    deps: { state: 'pending', lines: [] },
    models: { state: 'pending', lines: [] }
  })
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    window.obsar.drives().then((d) => {
      setDrives(d)
      const best = [...d].sort((a, b) => b.free - a.free)[0]
      if (best) setDir(best.path.replace(/[\\/]+$/, '') + '\\OBSAR')
    })
  }, [])

  useEffect(() => {
    return window.obsar.onSetup((ev) => {
      if (ev.step === 'done') {
        setPhase('finish')
        return
      }
      setSteps((s) => {
        const cur = s[ev.step] ?? { state: 'pending', lines: [] }
        return {
          ...s,
          [ev.step]: {
            state: ev.state,
            percent: ev.percent ?? cur.percent,
            lines: ev.line ? [...cur.lines.slice(-200), ev.line] : cur.lines,
            error: ev.error
          }
        }
      })
      if (ev.state === 'error') setFailed(ev.error ?? 'failed')
    })
  }, [])

  const need = NEED_BASE + NEED_EMBED + (captions ? NEED_CAPTION : 0)
  const drive = drives.find((d) => dir.toUpperCase().startsWith(d.path.toUpperCase().slice(0, 2)))
  const enough = drive ? drive.free > need * 1.1 : true

  const start = async () => {
    setFailed(null)
    setPhase('install')
    setSteps({ python: { state: 'pending', lines: [] }, deps: { state: 'pending', lines: [] }, models: { state: 'pending', lines: [] } })
    await window.obsar.runSetup({ dataDir: dir + '\\data', modelsDir: dir + '\\models', captions })
  }

  return (
    <div className="setup">
      <div className="setup-card">
        <div className="brand big"><Logo size={34} /></div>
        {phase === 'choose' && (
          <>
            <h1>Search your memes, clips and screenshots by what's in them.</h1>
            <p className="muted">
              OBSAR runs entirely on this PC. It needs a one-time download of its AI models and a Python runtime. Pick where to keep them.
            </p>
            <label className="field">
              <span>Install location</span>
              <div className="field-row">
                <input value={dir} onChange={(e) => setDir(e.target.value)} spellCheck={false} />
                <button
                  onClick={async () => {
                    const d = await window.obsar.pickFolder()
                    if (d) setDir(d.replace(/[\\/]+$/, '') + '\\OBSAR')
                  }}
                >
                  Browse
                </button>
              </div>
              <div className={'muted small' + (enough ? '' : ' bad')}>
                Needs about {fmtBytes(need, 0)}.{' '}
                {drive ? `${fmtBytes(drive.free, 0)} free on ${drive.path.slice(0, 2)}.` : ''}
                {!enough && ' Not enough space here.'}
              </div>
            </label>
            <div className="drives">
              {drives.map((d) => (
                <button key={d.path} className={'drive' + (drive?.path === d.path ? ' on' : '')} onClick={() => setDir(d.path.replace(/[\\/]+$/, '') + '\\OBSAR')}>
                  <b>{d.path.slice(0, 2)}</b>
                  <span>{fmtBytes(d.free, 0)} free</span>
                  <i style={{ width: `${Math.round(((d.total - d.free) / d.total) * 100)}%` }} />
                </button>
              ))}
            </div>
            <label className="toggle">
              <div>
                <div className="toggle-label">Captions and text recognition (+{fmtBytes(NEED_CAPTION, 1)})</div>
                <div className="muted small">Describes each file and reads any text so you can search by words too. Recommended with an NVIDIA GPU with 8 GB or more.</div>
              </div>
              <input type="checkbox" checked={captions} onChange={(e) => setCaptions(e.target.checked)} />
              <span className="switch" />
            </label>
            <div className="setup-actions">
              <button className="primary" onClick={start} disabled={!dir || !enough}>
                Install
              </button>
            </div>
          </>
        )}

        {phase === 'install' && (
          <>
            <h1>Setting up</h1>
            <p className="muted">This happens once. You can leave it running in the background.</p>
            {(
              [
                ['python', 'Python runtime', '~30 MB'],
                ['deps', 'AI libraries (PyTorch, Transformers)', '~6 GB'],
                ['models', captions ? 'Models (visual + captions)' : 'Model (visual)', fmtBytes(NEED_EMBED + (captions ? NEED_CAPTION : 0), 0)]
              ] as [string, string, string][]
            ).map(([key, label, size]) => {
              const st = steps[key]
              return (
                <details key={key} className={'step ' + st.state} open={st.state === 'error'}>
                  <summary>
                    <span className="dot" />
                    <span className="step-label">{label}</span>
                    <span className="muted small">{size}</span>
                    <span className="step-state">
                      {st.state === 'running' && st.percent !== undefined ? `${Math.round(st.percent)}%` : st.state === 'pending' ? '' : st.state}
                    </span>
                  </summary>
                  {st.state === 'running' && (
                    <div className="bar">
                      <div style={{ width: `${st.percent ?? 0}%` }} className={st.percent === undefined ? 'indeterminate' : ''} />
                    </div>
                  )}
                  {st.error && <div className="error-line">{st.error}</div>}
                  <pre className="log">{st.lines.slice(-40).join('\n')}</pre>
                </details>
              )
            })}
            <div className="setup-actions">
              {failed ? (
                <>
                  <button onClick={() => setPhase('choose')}>Back</button>
                  <button className="primary" onClick={start}>
                    Retry
                  </button>
                </>
              ) : (
                <button
                  onClick={() => {
                    window.obsar.cancelSetup()
                    setPhase('choose')
                  }}
                >
                  Cancel
                </button>
              )}
            </div>
          </>
        )}

        {phase === 'finish' && (
          <>
            <h1>Ready.</h1>
            <p className="muted">Add the folder where your media lives. Subfolders are included. You can add more later in Settings.</p>
            <div className="setup-actions">
              <button className="primary" onClick={onDone}>
                Choose a folder
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
