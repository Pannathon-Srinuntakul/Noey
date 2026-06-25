/** Visual encodings for the 3D data world: size = views, color = engagement rate.
 * Pure functions so they're unit-testable without a renderer. */

export const SPHERE_CAP = 400 // max spheres on screen (perf budget; aggregate beyond)

const MIN_R = 0.35
const MAX_R = 1.5

/** Sphere radius from view count, sqrt-scaled so area reads proportionally. */
export function sphereRadius(views: number, maxViews: number): number {
  if (maxViews <= 0 || views <= 0) return MIN_R
  const t = Math.sqrt(Math.min(views, maxViews) / maxViews)
  return MIN_R + t * (MAX_R - MIN_R)
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) => Math.round(n).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

function lerpHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a)
  const [br, bg, bb] = hexToRgb(b)
  const k = Math.min(1, Math.max(0, t))
  return rgbToHex(ar + (br - ar) * k, ag + (bg - ag) * k, ab + (bb - ab) * k)
}

const COOL = '#3b82f6' // low engagement
const WARM = '#f59e0b' // high engagement

/** Engagement rate as a 0.0–1.0 float. Threshold: 5% = fully warm. */
export function engagementColor(rate: number): string {
  return lerpHex(COOL, WARM, Math.min(rate / 0.05, 1))
}

/** Deterministic position on a roughly-cubic lattice, centered at origin. */
export function gridPosition(i: number, total: number): [number, number, number] {
  const side = Math.max(1, Math.ceil(Math.cbrt(total)))
  const gap = 2.4
  const x = i % side
  const y = Math.floor(i / side) % side
  const z = Math.floor(i / (side * side))
  const off = ((side - 1) * gap) / 2
  return [x * gap - off, y * gap - off, z * gap - off]
}
