import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'

/** How long the controls stay after the last pointer movement while playing. */
const IDLE_MS_MOUSE = 2000
/** Touch has no pointer resting on the frame, so a tap reveals for longer. */
const IDLE_MS_TOUCH = 4000

/** Pointer + focus handlers for the element the controls sit on. */
export interface AutoHideContainerProps {
  onPointerDown: (e: React.PointerEvent) => void
  onPointerEnter: (e: React.PointerEvent) => void
  onPointerMove: (e: React.PointerEvent) => void
  onPointerLeave: (e: React.PointerEvent) => void
  onFocus: (e: React.FocusEvent) => void
  onBlur: (e: React.FocusEvent) => void
}

export interface AutoHideControls {
  /** Show the controls now. */
  visible: boolean
  /** Reveal and (re)start the idle timer — any use of a control calls it. */
  show: () => void
  /** Take them away now (a second tap on a touch screen). */
  hide: () => void
  /** The last pointer on the frame was a finger. */
  coarseRef: React.RefObject<boolean>
  /** Spread on the frame element. */
  containerProps: AutoHideContainerProps
}

function isKeyboardFocus(el: EventTarget | null): boolean {
  if (!(el instanceof Element)) return false
  try {
    return el.matches(':focus-visible')
  } catch {
    return false
  }
}

/**
 * The video player's overlay auto-hide, shared by every transport — the
 * project page's VideoPlayer (and VideoModal through it) and the timeline
 * editor's stage, which kept its own copy that pinned the controls on screen
 * whenever playback was paused. Paused, with the pointer gone, they sat over
 * the bottom of the frame — over the captions (owner report 2026-10-03).
 *
 * On screen when:
 *  - the pointer is over the frame — while paused for as long as it stays,
 *    while playing until it rests for 2s (moving it brings them back);
 *  - keyboard focus is inside it (`:focus-visible`), so a Tab into the bar
 *    never lands on an invisible button;
 *  - a finger tapped the frame in the last 4s. A touch screen sends
 *    `pointermove` only while a finger is down and `pointerleave` the moment
 *    it lifts, so touch never takes the bar away on leave — its timer does.
 *
 * Off as soon as the pointer leaves, paused or playing.
 */
export function useAutoHideControls(playing: boolean): AutoHideControls {
  const [hovered, setHovered] = useState(false)
  const [active, setActive] = useState(false)
  const [focused, setFocused] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  const coarseRef = useRef(false)

  // Stable (refs and state setters only), so a window listener may hold them.
  const show = useCallback((): void => {
    setActive(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(
      () => setActive(false),
      coarseRef.current ? IDLE_MS_TOUCH : IDLE_MS_MOUSE
    )
  }, [])
  const hide = useCallback((): void => {
    window.clearTimeout(timer.current)
    setActive(false)
    setHovered(false)
  }, [])
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const containerProps: AutoHideContainerProps = {
    onPointerDown: (e) => {
      coarseRef.current = e.pointerType === 'touch'
    },
    onPointerEnter: (e) => {
      if (e.pointerType === 'touch') return
      setHovered(true)
      show()
    },
    onPointerMove: (e) => {
      if (e.pointerType === 'touch') return
      setHovered(true)
      show()
    },
    onPointerLeave: (e) => {
      // On touch this fires on lift, which is exactly when the bar needs to
      // STAY up. Its own timer takes it away.
      if (e.pointerType === 'touch') return
      hide()
    },
    onFocus: (e) => {
      // A mouse click focuses a button too; only keyboard focus pins the bar.
      setFocused(isKeyboardFocus(e.target))
    },
    onBlur: (e) => {
      const next = e.relatedTarget
      if (next instanceof Node && e.currentTarget.contains(next)) return
      setFocused(false)
    }
  }

  return {
    visible: focused || active || (hovered && !playing),
    show,
    hide,
    coarseRef,
    containerProps
  }
}
