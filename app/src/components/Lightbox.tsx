import { useEffect } from 'react'
import { Item, url } from '../api'

interface Props {
  item: Item
  onClose: () => void
  onPrev: () => void
  onNext: () => void
}

/** Full-size viewer for the focused result. Esc closes, arrows step through the current results. */
export function Lightbox({ item, onClose, onPrev, onNext }: Props) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft') onPrev()
      else if (e.key === 'ArrowRight') onNext()
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  }, [onClose, onPrev, onNext])

  const src = url(`/raw/${item.id}`)
  return (
    <div className="lightbox" onClick={onClose} role="dialog" aria-label={item.name}>
      <button className="lb-nav prev" onClick={(e) => { e.stopPropagation(); onPrev() }} aria-label="Previous">
        ‹
      </button>
      {item.kind === 'video' ? (
        <video src={src} controls autoPlay onClick={(e) => e.stopPropagation()} />
      ) : (
        <img src={src} alt={item.name} onClick={(e) => e.stopPropagation()} />
      )}
      <button className="lb-nav next" onClick={(e) => { e.stopPropagation(); onNext() }} aria-label="Next">
        ›
      </button>
      <div className="lb-caption" onClick={(e) => e.stopPropagation()}>
        <span>{item.name}</span>
        <button className="link" onClick={() => window.obsar.open(item.path)}>
          Open
        </button>
        <button className="link" onClick={() => window.obsar.reveal(item.path)}>
          Reveal
        </button>
      </div>
      <button className="lb-close icon-btn" onClick={onClose} aria-label="Close">
        ×
      </button>
    </div>
  )
}
