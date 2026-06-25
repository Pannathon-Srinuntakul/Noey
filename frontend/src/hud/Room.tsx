import type { ReactNode } from 'react'

/** Generic themed 2D room overlay — parchment panel with a wood frame. */
export function Room({
  title,
  icon,
  onClose,
  children,
}: {
  title: string
  icon?: string
  onClose: () => void
  children: ReactNode
}) {
  return (
    <div
      className="absolute inset-0 z-30 grid place-items-center bg-black/55 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-[min(94vw,560px)] flex-col overflow-hidden rounded-2xl border-4 border-[#5b3a1a] bg-gradient-to-b from-[#f5e9cb] to-[#e7d3a6] text-[#3a2a14] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        style={{ animation: 'roompop 0.18s ease' }}
      >
        <div className="flex items-center justify-between border-b-4 border-[#5b3a1a]/40 bg-[#5b3a1a]/15 px-5 py-3">
          <h2 className="font-bold">
            {icon && <span className="mr-1">{icon}</span>}
            {title}
          </h2>
          <button
            onClick={onClose}
            className="rounded-md px-2 text-[#5b3a1a] hover:bg-[#5b3a1a]/15"
            aria-label="close"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-5">{children}</div>
      </div>
      <style>{`@keyframes roompop { from { transform: translateY(10px) scale(.97); opacity: 0 } }`}</style>
    </div>
  )
}
