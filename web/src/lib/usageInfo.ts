import { createContext, useContext } from 'react'
import type { Usage } from './api'

export interface UsageContextValue {
  /** Null until the first answer (or when the server has no usage endpoint). */
  usage: Usage | null
  /** Re-read now — after a start, a plan change or a top-up. */
  refresh: () => void
}

/** Provided by `UsageProvider` (./usageContext.tsx). */
export const UsageContext = createContext<UsageContextValue>({
  usage: null,
  refresh: () => undefined
})

export function useUsageInfo(): UsageContextValue {
  return useContext(UsageContext)
}
