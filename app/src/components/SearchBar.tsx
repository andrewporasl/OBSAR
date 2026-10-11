import { forwardRef } from 'react'
import { Kind, Library } from '../api'

const KINDS: { k: Kind; label: string }[] = [
  { k: 'all', label: 'All' },
  { k: 'image', label: 'Images' },
  { k: 'gif', label: 'GIFs' },
  { k: 'video', label: 'Videos' }
]

interface Props {
  q: string
  onQ: (q: string) => void
  kind: Kind
  onKind: (k: Kind) => void
  library: number | null
  onLibrary: (id: number | null) => void
  libraries: Library[]
  disabled?: boolean
}

export const SearchBar = forwardRef<HTMLInputElement, Props>(function SearchBar(p, ref) {
  const enabled = p.libraries.filter((l) => l.enabled)
  return (
    <div className="search">
      <svg className="icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden>
        <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <input
        ref={ref}
        autoFocus
        spellCheck={false}
        placeholder={p.disabled ? 'Add a folder to start' : 'Search by what it looks like, what it says, or its name'}
        value={p.q}
        onChange={(e) => p.onQ(e.target.value)}
        disabled={p.disabled}
      />
      {p.q && (
        <button className="clear" onClick={() => p.onQ('')} title="Clear (Esc)" aria-label="Clear">
          ×
        </button>
      )}
      <div className="seg" role="tablist">
        {KINDS.map((k) => (
          <button key={k.k} role="tab" aria-selected={p.kind === k.k} className={p.kind === k.k ? 'on' : ''} onClick={() => p.onKind(k.k)}>
            {k.label}
          </button>
        ))}
      </div>
      {enabled.length > 1 && (
        <select className="libsel" value={p.library ?? ''} onChange={(e) => p.onLibrary(e.target.value ? Number(e.target.value) : null)} title="Library">
          <option value="">All libraries</option>
          {enabled.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      )}
    </div>
  )
})
