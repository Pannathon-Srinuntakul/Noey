import { Navigate } from 'react-router-dom'
import { useAuth } from './AuthContext'

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { accessToken, loading } = useAuth()
  if (loading) return null  // avoid flash
  if (!accessToken) return <Navigate to="/login" replace />
  return <>{children}</>
}
