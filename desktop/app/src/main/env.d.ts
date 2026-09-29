/** Build-time env electron-vite exposes to the main process (`VITE_` is shared
 *  with the renderer, so both sides see the same backend URL). */
interface ImportMetaEnv {
  readonly VITE_BACKEND_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
