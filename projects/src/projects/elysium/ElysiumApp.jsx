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
import ElysiumMySeries from './pages/MySeries'
import ElysiumImport from './pages/Import'
import ElysiumMyMovies from './pages/MyMovies'
import ElysiumDroppedSeries from './pages/DroppedSeries'
import ElysiumMySeriesPlanned from './pages/MySeriesPlanned'

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
          <Route index element={<ElysiumProtectedRoute><ElysiumMain /></ElysiumProtectedRoute>} />
          <Route path="movie/:id" element={<ElysiumProtectedRoute><ElysiumMovieDetail dbType="FILM" /></ElysiumProtectedRoute>} />
          <Route path="serial/:id" element={<ElysiumProtectedRoute><ElysiumMovieDetail dbType="TV_SERIES" /></ElysiumProtectedRoute>} />
          <Route path="friends" element={<ElysiumProtectedRoute><ElysiumFriends /></ElysiumProtectedRoute>} />
          <Route path="match" element={<ElysiumProtectedRoute><ElysiumMatch /></ElysiumProtectedRoute>} />
          <Route path="profile" element={<ElysiumProtectedRoute><ElysiumProfile /></ElysiumProtectedRoute>} />
          <Route path="profile/:id" element={<ElysiumProtectedRoute><ElysiumProfile /></ElysiumProtectedRoute>} />
          <Route path="my-series" element={<ElysiumProtectedRoute><ElysiumMySeries /></ElysiumProtectedRoute>} />
          <Route path="import" element={<ElysiumProtectedRoute><ElysiumImport /></ElysiumProtectedRoute>} />
          <Route path="my-movies" element={<ElysiumProtectedRoute><ElysiumMyMovies /></ElysiumProtectedRoute>} />
          <Route path="dropped-series" element={<ElysiumProtectedRoute><ElysiumDroppedSeries /></ElysiumProtectedRoute>} />
          <Route path="planned-series" element={<ElysiumProtectedRoute><ElysiumMySeriesPlanned /></ElysiumProtectedRoute>} />
        </Routes>
      </main>
      <ElysiumFooter />
    </div>
  )
}

export default ElysiumApp