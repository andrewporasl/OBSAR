import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { fmtDur, Item, url } from '../api'

const ROW = 8 // px, grid-auto-rows
const GAP = 10
const MIN_COL = 180

interface Props {
  items: Item[]
  selected: Set<number>
  focusId: number | null
  onTileClick: (e: React.MouseEvent, item: Item, idx: number) => void
  onOpen: (item: Item) => void
  onDragStart: (e: React.DragEvent, item: Item) => void
  onContext: (e: React.MouseEvent, item: Item) => void
  onBackgroundClick: () => void
}

/** Build a small PNG data URL from the tile's already-loaded thumbnail, synchronously. */
export function dragIcon(el: HTMLElement, count: number): string | undefined {
  const img = el.querySelector('img') as HTMLImageElement | null
  if (!img || !img.complete || !img.naturalWidth) return undefined
  try {
    const size = 96
    const c = document.createElement('canvas')
    const r = img.naturalWidth / img.naturalHeight
    c.width = r >= 1 ? size : Math.round(size * r)
    c.height = r >= 1 ? Math.round(size / r) : size
    const ctx = c.getContext('2d')!
    ctx.drawImage(img, 0, 0, c.width, c.height)
    if (count > 1) {
      ctx.fillStyle = '#4f7cff'
      ctx.beginPath()
      ctx.arc(c.width - 14, 14, 12, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#fff'
      ctx.font = 'bold 12px sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(count), c.width - 14, 14)
    }
    return c.toDataURL('image/png')
  } catch {
    return undefined
  }
}

export function ResultGrid(p: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [colW, setColW] = useState(MIN_COL)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth
      const cols = Math.max(1, Math.floor((w + GAP) / (MIN_COL + GAP)))
      setColW((w - GAP * (cols - 1)) / cols)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div
      className="grid"
      ref={ref}
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${MIN_COL}px, 1fr))`, gridAutoRows: ROW, gap: GAP }}
      onClick={(e) => {
        if (e.target === e.currentTarget) p.onBackgroundClick()
      }}
    >
      {p.items.map((it, idx) => {
        const ratio = it.width && it.height ? Math.min(Math.max(it.width / it.height, 0.55), 2.2) : 1
        const h = colW / ratio
        const span = Math.ceil((h + GAP) / (ROW + GAP))
        return (
          <Tile
            key={it.id}
            item={it}
            span={span}
            selected={p.selected.has(it.id)}
            focused={p.focusId === it.id}
            onClick={(e) => p.onTileClick(e, it, idx)}
            onDoubleClick={() => p.onOpen(it)}
            onDragStart={(e) => p.onDragStart(e, it)}
            onContextMenu={(e) => p.onContext(e, it)}
          />
        )
      })}
    </div>
  )
}

function Tile(props: {
  item: Item
  span: number
  selected: boolean
  focused: boolean
  onClick: (e: React.MouseEvent) => void
  onDoubleClick: () => void
  onDragStart: (e: React.DragEvent) => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  const { item } = props
  const [hover, setHover] = useState(false)
  const [previewReady, setPreviewReady] = useState(false)
  useEffect(() => setPreviewReady(false), [item.id])
  const animated = hover && item.preview
  return (
    <div
      className={'tile' + (props.selected ? ' sel' : '') + (props.focused ? ' focus' : '')}
      style={{ gridRowEnd: `span ${props.span}` }}
      draggable
      onDragStart={props.onDragStart}
      onClick={props.onClick}
      onDoubleClick={props.onDoubleClick}
      onContextMenu={props.onContextMenu}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={item.caption || item.name}
    >
      <img src={url(item.thumb)} alt="" loading="lazy" draggable={false} crossOrigin="anonymous" />
      {animated && (
        <img
          className={'anim' + (previewReady ? ' ready' : '')}
          src={url(item.preview!)}
          alt=""
          draggable={false}
          crossOrigin="anonymous"
          onLoad={() => setPreviewReady(true)}
        />
      )}
      {item.kind !== 'image' && (
        <span className={'badge ' + item.kind}>{item.kind === 'video' ? fmtDur(item.duration) || 'video' : 'GIF'}</span>
      )}
      <div className="name">{item.name}</div>
    </div>
  )
}
