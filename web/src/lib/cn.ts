/** Join class names, dropping falsy values. No Tailwind-conflict merging —
 * keep call sites from stacking two values for the same property. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}
