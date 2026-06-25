import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'

interface NavigationContextValue {
  navigateWithDoor: (to: string) => void
}

const NavigationContext = createContext<NavigationContextValue | null>(null)

export function NavigationProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  return (
    <NavigationContext.Provider value={{ navigateWithDoor: navigate }}>
      {children}
    </NavigationContext.Provider>
  )
}

export function useNavigateWithDoor() {
  const ctx = useContext(NavigationContext)
  if (!ctx) throw new Error('useNavigateWithDoor must be inside NavigationProvider')
  return ctx
}
