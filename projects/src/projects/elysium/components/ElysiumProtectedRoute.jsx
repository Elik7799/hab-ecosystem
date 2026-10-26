import { Navigate } from 'react-router-dom'
import { useAuth } from '../context/ElysiumAuthContext'

export default function ElysiumProtectedRoute({ children }) {
  const { user, loading } = useAuth()

  if (loading) return <div className="main-state">Загрузка...</div>

  if (!user) return <Navigate to="/elysium/login" replace />

  return children
}