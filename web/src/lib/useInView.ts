import { useEffect, useRef, useState } from 'react'

/**
 * True once the element has come near the viewport, and stays true.
 *
 * Used to keep a long grid from asking the server for every card at once: ten
 * finished projects each probed their render and mounted a <video>, which filled
 * the browser's six connections to the API and left the visible cards black
 * (live report 2026-09-22, production). `rootMargin` starts the work a screen
 * early so scrolling still feels instant.
 *
 * Sticky on purpose: a card that scrolls away keeps its picture instead of
 * re-fetching it on the way back.
 */
export function useInView<T extends HTMLElement>(
  rootMargin = '600px'
): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null)
  const [seen, setSeen] = useState(false)

  useEffect(() => {
    if (seen) return
    const el = ref.current
    // No element yet, or a browser without the observer: show everything rather
    // than nothing.
    if (!el || typeof IntersectionObserver === 'undefined') {
      setSeen(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true)
          observer.disconnect()
        }
      },
      { rootMargin }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [rootMargin, seen])

  return [ref, seen]
}
