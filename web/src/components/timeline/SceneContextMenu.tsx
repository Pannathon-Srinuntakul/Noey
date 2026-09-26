import { useEffect, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Menu, type MenuItemDef } from '../ui/Menu'
import { MENU_W_PX, clampMenuPosition, nextMenuIndex } from './contextMenu'

/**
 * The right-click menu on a scene — ui/Menu's rows at a fixed point, kept
 * inside the viewport (flipping above / left near the edges).
 *
 * Closes on an outside pointerdown (capture, so a block under the pointer
 * never gets the press), Escape, a window scroll or resize (the anchor moved),
 * or a selection. Focus moves into the menu on open and back to whatever had
 * it on close; ↑/↓ walk the items, Enter selects. `data-context-menu` on the
 * root lets the editor keep keyboard focus here (keepFocusOffControls).
 */
export function SceneContextMenu({
  at,
  items,
  onSelect,
  onClose
}: {
  at: { x: number; y: number }
  items: (MenuItemDef | { divider: true })[]
  onSelect: (key: string) => void
  onClose: () => void
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  // The latest callbacks, so the listeners below bind once per open and an
  // inline `onClose` from the editor does not re-run the focus dance.
  const onCloseRef = useRef(onClose)
  const onSelectRef = useRef(onSelect)
  useEffect(() => {
    onCloseRef.current = onClose
    onSelectRef.current = onSelect
  })

  // Measure the real panel height before the first paint, so the flip uses
  // it rather than a guess; written straight to the element — a state round
  // trip would paint the unclamped point first.
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const h = el.offsetHeight
    const pos = clampMenuPosition(at.x, at.y, MENU_W_PX, h, window.innerWidth, window.innerHeight)
    el.style.left = `${pos.left}px`
    el.style.top = `${pos.top}px`
  }, [at.x, at.y, items.length])

  useEffect(() => {
    const onClose = (): void => onCloseRef.current()
    restoreRef.current = document.activeElement as HTMLElement | null
    const root = rootRef.current
    root?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus()

    const onPointerDown = (e: PointerEvent): void => {
      if (root && e.target instanceof Node && root.contains(e.target)) return
      onClose()
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.preventDefault()
        onClose()
        return
      }
      if (e.key === 'Tab') {
        onClose()
        return
      }
      const buttons = root
        ? Array.from(root.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'))
        : []
      const current = buttons.findIndex((b) => b === document.activeElement)
      const next = nextMenuIndex(e.key, current, buttons.length)
      if (next !== null) {
        e.preventDefault()
        e.stopPropagation()
        buttons[next]?.focus()
      }
    }
    const onAway = (): void => onClose()

    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('scroll', onAway, true)
    window.addEventListener('resize', onAway)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('scroll', onAway, true)
      window.removeEventListener('resize', onAway)
      const prev = restoreRef.current
      if (prev && prev.isConnected && typeof prev.focus === 'function') prev.focus()
    }
  }, [])

  return createPortal(
    <div
      ref={rootRef}
      data-context-menu
      className="fixed z-[70]"
      style={{ left: at.x, top: at.y, width: MENU_W_PX }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <Menu
        items={items}
        onSelect={(key) => {
          onSelectRef.current(key)
          onCloseRef.current()
        }}
      />
    </div>,
    document.body
  )
}
