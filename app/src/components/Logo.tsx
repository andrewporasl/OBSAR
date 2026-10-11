/** Minimal mark: a lens with a tiny picture inside. Used in the top bar and the setup screen. */
export function Logo({ size = 22, title = 'OBSAR' }: { size?: number; title?: string }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={title}>
      <circle cx="10.5" cy="10.5" r="7.25" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M16 16l5 5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M6.5 13.2l2.6-2.9 1.9 2 1.5-1.6 2 2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx="8.3" cy="7.6" r="1.1" fill="var(--accent)" />
    </svg>
  )
}
