import { Routes, Route } from 'react-router-dom'
import ElysiumHeader from './components/ElysiumHeader'
import ElysiumFooter from './components/ElysiumFooter'
import ElysiumProtectedRoute from './components/ElysiumProtectedRoute'
import ElysiumMain from './pages/Main'
import ElysiumLogin from './pages/Login'
import ElysiumRegister from './pages/Register'
import ElysiumFriends from './pages/Friends'
import ElysiumMatch from './pages/Match'
import ElysiumMovieDetail from './pages/MovieDetail'
import ElysiumProfile from './pages/Profile'

import './elysium.css'
import './elysiumMobile.css'

function ElysiumApp() {
  return (
    <div className="app-wrapper">
      <ElysiumHeader />
      <main className="app-main">
        <Routes>
          <Route path="login" element={<ElysiumLogin />} />
          <Route path="register" element={<ElysiumRegister />} />
          
          {/* ИСПРАВЛЕНО: path="/" заменен на index */}
          <Route
            index
            element={
              <ElysiumProtectedRoute>
                <ElysiumMain />
              </ElysiumProtectedRoute>
            }
          />
          
          <Route
            path="movie/:id"
            element={
              <ElysiumProtectedRoute>
                <ElysiumMovieDetail />
              </ElysiumProtectedRoute>
            }
          />
          <Route
            path="friends"
            element={
              <ElysiumProtectedRoute>
                <ElysiumFriends />
              </ElysiumProtectedRoute>
            }
          />
          <Route
            path="match"
            element={
              <ElysiumProtectedRoute>
                <ElysiumMatch />
              </ElysiumProtectedRoute>
            }
          />
          <Route
            path="profile"
            element={
              <ElysiumProtectedRoute>
                <ElysiumProfile />
              </ElysiumProtectedRoute>
            }
          />
          <Route
            path="profile/:id"
            element={
              <ElysiumProtectedRoute>
                <ElysiumProfile />
              </ElysiumProtectedRoute>
            }
          />
        </Routes>
      </main>
      <ElysiumFooter />
    </div>
  )
}

export default ElysiumApp