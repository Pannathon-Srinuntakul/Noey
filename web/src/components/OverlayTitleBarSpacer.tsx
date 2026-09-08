import { BrandMark } from './ui/BrandMark'

/**
 * The custom-titlebar strip (38px, see HANDOFF §4 and main/index.ts) as drawn
 * INSIDE a `fixed inset-0` fullscreen takeover.
 *
 * `fixed` positioning escapes the normal app layout — where the shell's own
 * <TitleBar/> occupies this space via flex — so any `fixed inset-0` overlay
 * (VideoTimelineEditor, EffectsCanvasEditor, …) would otherwise start at the
 * true window top, under the OS caption buttons (Windows) or traffic lights
 * (macOS), and paint over the shell's title bar. Render this as the FIRST child
 * of any such overlay, and pass it the same label/note the shell would show —
 * the design keeps the screen name and the autosave note visible on these
 * screens too, and an empty strip loses both.
 *
 * Both platforms need the strip: Windows draws caption buttons on the right via
 * `titleBarOverlay`, macOS floats traffic lights on the left via `hiddenInset`.
 * Linux keeps its native frame, so nothing is reserved there — but the label
 * still belongs on screen, so the strip renders without the drag region.
 */
export function OverlayTitleBarSpacer({
  label,
  rightNote
}: {
  /** e.g. "แก้ไขวิดีโอ — promo_9.9 · ตัดฉากเด่น". */
  label?: string
  /** e.g. "บันทึกร่างอัตโนมัติ · 10:04". */
  rightNote?: string
} = {}): React.JSX.Element | null {
  const platform = window.noey.platform
  const isMac = platform === 'darwin'
  const reserves = platform === 'win32' || isMac
  if (!reserves && !label && !rightNote) return null

  return (
    <div
      data-app-chrome
      className="flex h-[38px] shrink-0 items-center justify-between border-b border-divider bg-surface px-3.5"
      style={reserves ? ({ WebkitAppRegion: 'drag' } as React.CSSProperties) : undefined}
    >
      {/* Same as the shell's TitleBar: the brand mark, not fake traffic-light
          dots. Keep the two strips identical — an overlay that swaps the window
          chrome for a different-looking one reads as a different window. */}
      <span className={`flex min-w-0 flex-1 items-center gap-2 ${isMac ? 'pl-[68px]' : ''}`}>
        <BrandMark size={14} className="shrink-0 text-accent" />
        <span className="truncate text-[13px] text-muted">{label ?? ''}</span>
      </span>
      {rightNote ? <span className="shrink-0 pl-4 text-[13px] text-muted">{rightNote}</span> : null}
    </div>
  )
}
