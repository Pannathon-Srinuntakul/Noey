import { ElectronAPI } from '@electron-toolkit/preload'
import type { NoeyApi } from './index'

declare global {
  interface Window {
    electron: ElectronAPI
    noey: NoeyApi
  }
}
