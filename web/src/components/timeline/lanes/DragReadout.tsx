/**
 * The pill above a block while a drag is live — '+0.40 วิ (+12 เฟรม) · ยาว
 * 2.10 วิ' over the handle being dragged, 'เลื่อนหน้าต่าง +0.40 วิ' over the
 * block for a slip / roll / move. Rendered from block-local state the drag
 * frames set; a trim frame re-renders the editor anyway, so it costs nothing.
 *
 * `pointer-events-none`: it sits under the pointer and must never steal the
 * drag. Above the sticky track labels (z-40) so it is readable at the left
 * edge too.
 */
export function DragReadout({
  text,
  anchor = 'center',
  tone = 'default'
}: {
  text: string | null
  /** Which edge of the block it hangs over. */
  anchor?: 'left' | 'right' | 'center'
  /** 'limit' when the edge is pinned at the end of the footage. */
  tone?: 'default' | 'limit'
}): React.JSX.Element | null {
  if (!text) return null
  const pos =
    anchor === 'left' ? 'left-0' : anchor === 'right' ? 'right-0' : 'left-1/2 -translate-x-1/2'
  return (
    <span
      role="status"
      className={`pointer-events-none absolute -top-6 z-50 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] font-medium tabular-nums shadow-md ${pos} ${
        tone === 'limit'
          ? 'border-error bg-[rgb(28_28_30_/_0.96)] text-error'
          : 'border-border-strong bg-[rgb(28_28_30_/_0.96)] text-ink'
      }`}
    >
      {text}
    </span>
  )
}
