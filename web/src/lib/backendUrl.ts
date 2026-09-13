/**
 * The one backend origin, baked in at build time — users never see or set it.
 * Override for local dev/self-hosting: VITE_BACKEND_URL=... npm run build
 *
 * Lives in its own module because the phone-transfer upload page needs it
 * OUTSIDE the app shell (it renders before login and before the capability
 * gate), and importing App.tsx from there would drag the whole app into a
 * page whose job is one file input.
 */
export const BACKEND_URL =
  import.meta.env.VITE_BACKEND_URL ?? 'https://noey-api-production.up.railway.app'
