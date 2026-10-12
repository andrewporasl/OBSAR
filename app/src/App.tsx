import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, Item, Kind } from './api'
import { useBackend } from './hooks/useBackend'
import { SearchBar } from './components/SearchBar'
import { ResultGrid, dragIcon } from './components/ResultGrid'
import { DetailPanel } from './components/DetailPanel'
import { StatusBar } from './components/StatusBar'
import { SettingsPanel } from './components/SettingsPanel'
import { SetupWizard } from './components/SetupWizard'
import { Logo } from './components/Logo'
import { Lightbox } from './components/Lightbox'
import type { AppSettings, UpdateEvent } from '../electron/preload'

export default function App() {
  const be = useBackend()
  const { info, status, libraries, storage, down, log } = be
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [q, setQ] = useState('')
  const [kind, setKind] = useState<Kind>('all')
  const [library, setLibrary] = useState<number | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [degraded, setDegraded] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [focusId, setFocusId] = useState<number | null>(null)
  const [similarOf, setSimilarOf] = useState<Item | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [settingsTab, setSettingsTab] = useState<'libraries' | 'storage' | 'general' | 'about'>('libraries')
  const [lightbox, setLightbox] = useState<Item | null>(null)
  const [update, setUpdate] = useState<UpdateEvent>({ state: 'idle' })
  const [whatsNew, setWhatsNew] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const lastClick = useRef<number | null>(null)

  useEffect(() => {
    if (!info) return
    setSettings(info.settings)
    if (info.packaged && info.settings.lastSeenVersion && info.settings.lastSeenVersion !== info.version) setWhatsNew(info.version)
    if (info.settings.lastSeenVersion !== info.version) window.obsar.setSettings({ lastSeenVersion: info.version })
  }, [info])

  useEffect(() => window.obsar.onUpdate(setUpdate), [])

  const updateSettings = async (patch: Partial<AppSettings>) => {
    const s = await window.obsar.setSettings(patch)
    setSettings(s)
  }

  // ---- search ---------------------------------------------------------
  const runSearch = useCallback(async () => {
    if (!info || info.needsSetup) return
    abortRef.current?.abort()
    const ctl = new AbortController()
    abortRef.current = ctl
    try {
      if (similarOf) {
        const r = await api.similar(similarOf.id)
        if (!ctl.signal.aborted) setItems(r.items)
      } else {
        const r = await api.search(q, kind, library, 80, ctl.signal)
        if (!ctl.signal.aborted) {
          setItems(r.items)
          setDegraded(r.degraded)
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') console.warn(e)
    }
  }, [q, kind, library, info, similarOf])

  useEffect(() => {
    const t = setTimeout(runSearch, q ? 140 : 0)
    return () => clearTimeout(t)
  }, [runSearch, q])

  // results refresh as indexing progresses
  const doneCount = status?.done ?? -1
  const total = status?.total ?? -1
  const libCount = status?.library_count ?? -1
  useEffect(() => {
    if (doneCount >= 0) runSearch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doneCount, total, libCount])

  // ---- selection / actions --------------------------------------------
  const onTileClick = (e: React.MouseEvent, item: Item, idx: number) => {
    setFocusId(item.id)
    setSelected((prev) => {
      const next = new Set(prev)
      if (e.ctrlKey || e.metaKey) {
        next.has(item.id) ? next.delete(item.id) : next.add(item.id)
      } else if (e.shiftKey && lastClick.current !== null) {
        const a = Math.min(lastClick.current, idx),
          b = Math.max(lastClick.current, idx)
        for (let i = a; i <= b; i++) next.add(items[i].id)
      } else {
        next.clear()
        next.add(item.id)
      }
      return next
    })
    if (!e.shiftKey) lastClick.current = idx
  }

  const onDragStart = (e: React.DragEvent, item: Item) => {
    e.preventDefault()
    const ids = selected.has(item.id) ? selected : new Set([item.id])
    const files = items.filter((i) => ids.has(i.id)).map((i) => i.path)
    window.obsar.dragOut(files, dragIcon(e.currentTarget as HTMLElement, ids.size))
  }

  const onContext = async (e: React.MouseEvent, item: Item) => {
    e.preventDefault()
    if (!selected.has(item.id)) {
      setSelected(new Set([item.id]))
      setFocusId(item.id)
    }
    const action = await window.obsar.contextMenu({ path: item.path, id: item.id })
    switch (action) {
      case 'open':
        window.obsar.open(item.path)
        break
      case 'reveal':
        window.obsar.reveal(item.path)
        break
      case 'copyPath':
        window.obsar.copyPath(item.path)
        break
      case 'copyImage': {
        const ok = await window.obsar.copyImage(item.path)
        if (!ok) window.obsar.copyPath(item.path)
        break
      }
      case 'similar':
        setSimilarOf(item)
        break
      case 'reindex':
        await api.reindex(item.id)
        break
    }
  }

  // ---- keyboard -------------------------------------------------------
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
      if (mod && e.key === ',') {
        e.preventDefault()
        setShowSettings((v) => !v)
      }
      const typing = document.activeElement === inputRef.current
      if (!typing && !showSettings && !lightbox && items.length && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '].includes(e.key)) {
        e.preventDefault()
        const idx = focusId ? items.findIndex((i) => i.id === focusId) : -1
        if (e.key === ' ') {
          if (idx >= 0)
            setSelected((p) => {
              const n = new Set(p)
              n.has(items[idx].id) ? n.delete(items[idx].id) : n.add(items[idx].id)
              return n
            })
          return
        }
        const grid = document.querySelector('.grid') as HTMLElement | null
        const cols = grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 4
        let next = idx
        if (e.key === 'ArrowRight') next = Math.min(items.length - 1, idx + 1)
        if (e.key === 'ArrowLeft') next = Math.max(0, idx - 1)
        if (e.key === 'ArrowDown') next = Math.min(items.length - 1, idx + cols)
        if (e.key === 'ArrowUp') next = Math.max(0, idx - cols)
        if (idx < 0) next = 0
        const it = items[next]
        setFocusId(it.id)
        setSelected(new Set([it.id]))
        lastClick.current = next
        return
      }
      if (e.key === 'Escape') {
        if (lightbox) return
        if (showSettings) setShowSettings(false)
        else if (similarOf) setSimilarOf(null)
        else if (document.activeElement === inputRef.current && q) setQ('')
        else {
          setSelected(new Set())
          setFocusId(null)
        }
      }
      if (e.key === 'Enter' && focusId && document.activeElement !== inputRef.current && !showSettings) {
        const it = items.find((i) => i.id === focusId)
        if (it) window.obsar.open(it.path)
      }
      if (mod && e.key.toLowerCase() === 'a' && document.activeElement !== inputRef.current && !showSettings) {
        e.preventDefault()
        setSelected(new Set(items.map((i) => i.id)))
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [items, focusId, q, similarOf, showSettings, lightbox])

  useEffect(() => {
    const offs = [
      window.obsar.onFocusSearch(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      }),
      window.obsar.onOpenSettings(() => {
        setSettingsTab('libraries')
        setShowSettings(true)
      })
    ]
    return () => offs.forEach((f) => f())
  }, [])

  const addFolder = async () => {
    const dir = await window.obsar.pickFolder()
    if (!dir) return
    try {
      await api.addLibrary(dir)
      be.refreshLibraries()
    } catch (e) {
      console.warn(e)
    }
  }

  const focused = useMemo(() => items.find((i) => i.id === focusId) ?? null, [items, focusId])
  const hasLibs = (status?.library_count ?? 0) > 0

  if (info?.needsSetup) {
    return (
      <SetupWizard
        onDone={async () => {
          await be.refreshInfo()
          addFolder()
        }}
      />
    )
  }

  return (
    <div className="app">
      <header className="top">
        <div className="brand" title="OBSAR"><Logo /></div>
        <SearchBar
          ref={inputRef}
          q={q}
          onQ={(v) => {
            setQ(v)
            setSimilarOf(null)
          }}
          kind={kind}
          onKind={setKind}
          library={library}
          onLibrary={setLibrary}
          libraries={libraries}
          disabled={!hasLibs}
        />
      </header>

      {similarOf && (
        <div className="banner">
          Showing files similar to <b>{similarOf.name}</b>
          <button className="link" onClick={() => setSimilarOf(null)}>
            Back to search
          </button>
        </div>
      )}

      <main className={'body' + (focused ? ' with-side' : '')}>
        <section
          className="grid-wrap"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setSelected(new Set())
              setFocusId(null)
            }
          }}
        >
          {!hasLibs && status && (
            <div className="empty">
              <div className="glyph" aria-hidden>
                <svg viewBox="0 0 64 64" width="56" height="56">
                  <rect x="6" y="14" width="52" height="38" rx="6" fill="none" stroke="currentColor" strokeWidth="2.5" />
                  <path d="M6 24h52" stroke="currentColor" strokeWidth="2.5" />
                  <circle cx="26" cy="38" r="5" fill="currentColor" opacity=".6" />
                  <path d="M14 48l12-10 8 6 8-9 10 13" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
                </svg>
              </div>
              <h2>Add your first folder</h2>
              <p>Everything inside it, including subfolders, gets indexed on this PC. Then type what you remember and drag the result anywhere.</p>
              <button className="primary" onClick={addFolder}>
                Add folder
              </button>
            </div>
          )}
          {hasLibs && !items.length && status && (
            <div className="empty small">
              {status.pending > 0 ? 'Indexing… results show up as files finish.' : q ? 'Nothing matched.' : 'No media found in your libraries.'}
            </div>
          )}
          <ResultGrid
            items={items}
            selected={selected}
            focusId={focusId}
            onTileClick={onTileClick}
            onOpen={(it) => (it.kind === 'video' ? window.obsar.open(it.path) : setLightbox(it))}
            onDragStart={onDragStart}
            onContext={onContext}
            onBackgroundClick={() => {
              setSelected(new Set())
              setFocusId(null)
            }}
          />
        </section>
        {focused && (
          <DetailPanel
            item={focused}
            libraries={libraries}
            onDragStart={onDragStart}
            onSimilar={setSimilarOf}
            onLightbox={setLightbox}
            onClose={() => {
              setFocusId(null)
              setSelected(new Set())
            }}
          />
        )}
      </main>

      <StatusBar
        status={status}
        down={down}
        degraded={degraded}
        selectedCount={selected.size}
        update={update}
        onSettings={() => {
          setSettingsTab('libraries')
          setShowSettings(true)
        }}
        onRestart={() => window.obsar.restartBackend()}
      />

      {whatsNew && (
        <div className="toast">
          <span>Updated to OBSAR {whatsNew}.</span>
          <button
            className="link"
            onClick={() => {
              setWhatsNew(null)
              setSettingsTab('about')
              setShowSettings(true)
            }}
          >
            What's new
          </button>
          <button className="icon-btn" onClick={() => setWhatsNew(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {lightbox && (
        <Lightbox
          item={lightbox}
          onClose={() => setLightbox(null)}
          onPrev={() => {
            const i = items.findIndex((x) => x.id === lightbox.id)
            if (i > 0) {
              setLightbox(items[i - 1])
              setFocusId(items[i - 1].id)
            }
          }}
          onNext={() => {
            const i = items.findIndex((x) => x.id === lightbox.id)
            if (i >= 0 && i < items.length - 1) {
              setLightbox(items[i + 1])
              setFocusId(items[i + 1].id)
            }
          }}
        />
      )}

      {showSettings && settings && (
        <SettingsPanel
          initialTab={settingsTab}
          update={update}
          status={status}
          libraries={libraries}
          storage={storage}
          settings={settings}
          log={log}
          onClose={() => setShowSettings(false)}
          onChanged={be.refreshLibraries}
          onStorageRefresh={be.refreshStorage}
          onSettings={updateSettings}
        />
      )}
    </div>
  )
}
