/// <reference types="vite/client" />

import type { NoeyApi } from './platform/noey-web'

declare global {
  interface Window {
    noey: NoeyApi
    /**
     * Electron's own bridge. Absent here — declared optional so the three file
     * pickers that feature-detect it (`pickFile`, `pickVideoFiles`,
     * `WizardPage`) keep compiling against the shared source.
     */
    electron?: {
      webUtils?: { getPathForFile?: (file: File) => string }
    }
  }
}

interface ImportMetaEnv {
  /** Backend base URL baked in at build time. Falls back to the production
   *  deployment when unset. Override for local dev:
   *  VITE_BACKEND_URL=http://localhost:8000 npm run dev */
  readonly VITE_BACKEND_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
