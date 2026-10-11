import { fmtBytes, fmtDur, Item, Library, url } from '../api'

interface Props {
  item: Item
  libraries: Library[]
  onDragStart: (e: React.DragEvent, item: Item) => void
  onSimilar: (item: Item) => void
  onClose: () => void
}

export function DetailPanel({ item, libraries, onDragStart, onSimilar, onClose }: Props) {
  const lib = libraries.find((l) => l.id === item.library_id)
  const rows: [string, string][] = [
    ['Type', item.kind.toUpperCase()],
    ['Size', fmtBytes(item.size)],
    ...(item.width ? ([['Dimensions', `${item.width} × ${item.height}`]] as [string, string][]) : []),
    ...(item.duration ? ([['Duration', fmtDur(item.duration)]] as [string, string][]) : []),
    ...(lib ? ([['Library', lib.name]] as [string, string][]) : []),
    ...(item.score !== undefined
      ? ([['Match', `${Math.round(item.score * 100)}%  (visual ${Math.round((item.vis ?? 0) * 100)} · text ${Math.round((item.txt ?? 0) * 100)})`]] as [string, string][])
      : [])
  ]
  return (
    <aside className="side">
      <div className="side-head">
        <span className="side-title">Details</span>
        <button className="icon-btn" onClick={onClose} title="Close (Esc)" aria-label="Close">
          ×
        </button>
      </div>
      <div className="side-img">
        <img src={url(item.preview ?? item.thumb)} alt="" draggable crossOrigin="anonymous" onDragStart={(e) => onDragStart(e, item)} />
      </div>
      <div className="side-name" title={item.path}>
        {item.name}
      </div>
      <dl className="kv">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {item.caption && <blockquote className="caption">{item.caption}</blockquote>}
      {item.ocr && (
        <div className="ocr-wrap">
          <div className="ocr-head">
            <span>Text in {item.kind === 'image' ? 'image' : 'frames'}</span>
            <button className="link" onClick={() => window.obsar.copyText(item.ocr)}>
              Copy
            </button>
          </div>
          <pre className="ocr">{item.ocr}</pre>
        </div>
      )}
      <div className="actions">
        <button onClick={() => window.obsar.open(item.path)}>Open</button>
        <button onClick={() => window.obsar.reveal(item.path)}>Reveal</button>
        <button onClick={() => window.obsar.copyImage(item.path)}>Copy</button>
        <button onClick={() => onSimilar(item)}>Similar</button>
      </div>
      <div className="hint">Drag the tile or this preview into any app to drop the real file.</div>
    </aside>
  )
}
