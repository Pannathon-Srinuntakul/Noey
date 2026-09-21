/**
 * PNG app icons, generated at build time by `app/icons/[name]/route.ts` from
 * the logo's app-icon spec (no binaries in the repo). Every reference to one of
 * them goes through `appIconPath`, so a typo in a name fails the type check
 * instead of shipping a 404 (the manifest and the Organization logo use them).
 */
export const APP_ICONS = {
  "icon-192.png": { size: 192, rounded: true },
  "icon-512.png": { size: 512, rounded: true },
  // Maskable: full-bleed tile, mark inside the 80% safe zone.
  "icon-maskable-512.png": { size: 512, rounded: false },
} as const;

export type AppIconName = keyof typeof APP_ICONS;

export function appIconPath(name: AppIconName): string {
  return `/icons/${name}`;
}
