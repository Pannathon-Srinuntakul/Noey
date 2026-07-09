/// <reference types="vite/client" />

import type { ElectronAPI } from '@electron-toolkit/preload'
import type { NoeyApi } from '../../preload/index'

declare global {
  interface Window {
    electron: ElectronAPI
    noey: NoeyApi
  }
}

interface ImportMetaEnv {
  /** Backend base URL baked in at build time. Falls back to the production
   *  Railway deployment when unset. Override for local dev/self-hosting:
   *  VITE_BACKEND_URL=http://localhost:8000 npm run build */
  readonly VITE_BACKEND_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
