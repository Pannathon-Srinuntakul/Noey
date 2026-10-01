/**
 * A timecode that counts the real wait from the moment it appears — CSS
 * counters (loading.css), so it runs before hydration, without JavaScript
 * and with reduced motion. Never a percentage: nobody knows how much is left.
 * Its own module so the editor-opening card (on every page) can use it
 * without the route loading states' stylesheet.
 */
export function WaitClock({ className }: { className?: string }) {
  return <span className={["tc ld-tc", className].filter(Boolean).join(" ")} aria-hidden="true" />;
}
