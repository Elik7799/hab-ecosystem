import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/ElysiumAuthContext'
import { getMovieName, getMoviePath } from '../../../utils/ElysiumMovieName'
import { showSuccess, showError } from '../../../utils/ElysiumToast'
import { useScrollRestore, scrollToTop } from '../../../utils/ElysiumScroll'
import { Check, ArrowDownUp, Clock, Star, ChevronLeft, ChevronRight, X } from 'lucide-react'

const API_URL_BACKEND = 'https://hab-ecosystem.onrender.com/api'
const PAGE_SIZE = 20

const SESSION_KEY = 'my-movies-session-active'
const SCROLL_KEY = 'my-movies-scroll'
const MOVIES_KEY = 'my-movies-data'
const PAGE_KEY = 'my-movies-page'
const SORT_KEY = 'my-movies-sort'

const SORT_OPTIONS = [
  { value: 'name_asc', label: 'По названию (А-Я)' },
  { value: 'name_desc', label: 'По названию (Я-А)' },
  { value: 'year_desc', label: 'По году (новые-старые)' },
  { value: 'year_asc', label: 'По году (старые-новые)' },
  { value: 'rating_desc', label: 'По рейтингу' },
]

const isSessionRestore = () => sessionStorage.getItem(SESSION_KEY) === 'true'

function readSavedMovies() {
  if (!isSessionRestore()) return []
  try {
    const parsed = JSON.parse(localStorage.getItem(MOVIES_KEY) || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

function readSavedPage() {
  if (!isSessionRestore()) return 1
  const p = Number(localStorage.getItem(PAGE_KEY))
  return Number.isFinite(p) && p >= 1 ? p : 1
}

export default function ElysiumMyMovies() {
  const { token } = useAuth()

  useEffect(() => { sessionStorage.setItem(SESSION_KEY, 'true') }, [])

  const [movies, setMovies] = useState(readSavedMovies)
  const [loading, setLoading] = useState(() => readSavedMovies().length === 0)
  const [updatingId, setUpdatingId] = useState(null)
  const [removingId, setRemovingId] = useState(null)
  const [sortBy, setSortBy] = useState(() => localStorage.getItem(SORT_KEY) || 'name_asc')
  const [page, setPage] = useState(readSavedPage)

  const restoredFromStorage = useRef(movies.length > 0)

  useScrollRestore(SCROLL_KEY, !loading)

  const fetchMovies = async () => {
    if (!token) return
    try {
      const res = await fetch(`${API_URL_BACKEND}/users/me/watchlist`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) {
        const data = await res.json()
        setMovies(data.movies || [])
      }
    } catch {
      showError('Ошибка загрузки')
    } finally { setLoading(false) }
  }

  useEffect(() => {
    if (!token) return
    if (restoredFromStorage.current) {
      restoredFromStorage.current = false
      setLoading(false)
      return
    }
    fetchMovies()
  }, [token])

  useEffect(() => { localStorage.setItem(SORT_KEY, sortBy) }, [sortBy])
  useEffect(() => { localStorage.setItem(MOVIES_KEY, JSON.stringify(movies)) }, [movies])
  useEffect(() => { localStorage.setItem(PAGE_KEY, String(page)) }, [page])

  const handleMarkWatched = async (movie) => {
    setUpdatingId(movie.kinopoiskId)
    try {
      const res = await fetch(
        `${API_URL_BACKEND}/movies/movie/${movie.kinopoiskId}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ status: 'watched' }),
        }
      )
      if (res.ok) {
        showSuccess(`«${getMovieName(movie)}» просмотрен`)
        setMovies(p => p.filter(m => m.kinopoiskId !== movie.kinopoiskId))
      } else {
        const d = await res.json()
        showError(d.error || 'Ошибка')
      }
    } catch {
      showError('Ошибка')
    } finally { setUpdatingId(null) }
  }

  const handleRemove = async (movie) => {
    setRemovingId(movie.kinopoiskId)
    try {
      const res = await fetch(
        `${API_URL_BACKEND}/movies/movie/${movie.kinopoiskId}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ status: 'not_watched' }),
        }
      )
      if (res.ok) {
        showSuccess(`«${getMovieName(movie)}» убран из списка`)
        setMovies(p => p.filter(m => m.kinopoiskId !== movie.kinopoiskId))
      } else {
        const d = await res.json().catch(() => ({}))
        showError(d.error || 'Ошибка')
      }
    } catch {
      showError('Ошибка')
    } finally {
      setRemovingId(null)
    }
  }

  const handleSortChange = (value) => {
    setSortBy(value)
    setPage(1)
    scrollToTop()
    sessionStorage.removeItem(SCROLL_KEY)
  }

  const sorted = [...movies].sort((a, b) => {
    switch (sortBy) {
      case 'name_asc': return getMovieName(a).localeCompare(getMovieName(b), 'ru')
      case 'name_desc': return getMovieName(b).localeCompare(getMovieName(a), 'ru')
      case 'year_desc': {
        const d = (b.year || 0) - (a.year || 0)
        return d || getMovieName(a).localeCompare(getMovieName(b), 'ru')
      }
      case 'year_asc': {
        const d = (a.year || 0) - (b.year || 0)
        return d || getMovieName(a).localeCompare(getMovieName(b), 'ru')
      }
      case 'rating_desc': {
        const d = (b.ratingKinopoisk || 0) - (a.ratingKinopoisk || 0)
        return d || getMovieName(a).localeCompare(getMovieName(b), 'ru')
      }
      default: return 0
    }
  })

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE))
  const pageClamped = Math.min(Math.max(1, page), totalPages)
  const pageItems = sorted.slice((pageClamped - 1) * PAGE_SIZE, pageClamped * PAGE_SIZE)

  useEffect(() => {
    if (loading) return
    if (page !== pageClamped) setPage(pageClamped)
  }, [page, pageClamped, loading])

  const handlePageChange = (next) => {
    setPage(next)
    scrollToTop()
    sessionStorage.setItem(SCROLL_KEY, '0')
  }

  if (loading) return (
    <div className="my-series-body">
      <h1 className="my-series-title">Мои фильмы</h1>
      <p className="my-series-empty">Загрузка...</p>
    </div>
  )

  return (
    <div className="my-series-body">
      <div className="my-series-header-row">
        <div>
          <h1 className="my-series-title">Мои фильмы</h1>
          <p className="my-series-subtitle">Фильмы, которые вы хотите посмотреть</p>
        </div>
        <div className="my-series-sort">
          <ArrowDownUp size={16} />
          <select
            value={sortBy}
            onChange={e => handleSortChange(e.target.value)}
            className="my-series-sort-select"
          >
            {SORT_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>

      {movies.length === 0 ? (
        <p className="my-series-empty">
          У вас пока нет фильмов в статусе «Буду смотреть».{' '}
          <Link to="/elysium" className="my-series-link">Найти фильм</Link>
        </p>
      ) : (
        <>
          <div className="my-movies-list">
            {pageItems.map(movie => (
              <div key={movie.kinopoiskId} className="my-movies-card">
                <Link to={getMoviePath(movie)}>
                  <img
                    src={movie.posterUrlPreview || 'https://kinopoiskapiunofficial.tech/images/posters/kp/no-poster.png'}
                    alt={getMovieName(movie)}
                    className="my-movies-poster"
                    onError={e => { e.target.src = 'https://kinopoiskapiunofficial.tech/images/posters/kp/no-poster.png' }}
                  />
                </Link>
                <div className="my-movies-info">
                  <Link to={getMoviePath(movie)} className="my-movies-name">
                    {getMovieName(movie)}
                  </Link>
                  {movie.nameOriginal && (
                    <p className="my-movies-original">{movie.nameOriginal}</p>
                  )}
                  <div className="my-movies-meta">
                    <span className="my-movies-year">
                      {movie.year && movie.year !== 0 ? movie.year : '—'}
                    </span>
                    <span className="my-movies-meta-item">
                      <Clock size={12} />
                      {movie.filmLength ? `${movie.filmLength} мин` : '—'}
                    </span>
                    <span className="my-movies-meta-item my-movies-rating">
                      <Star size={12} />
                      {movie.ratingKinopoisk || '—'}
                    </span>
                  </div>
                </div>
                {(() => {
                  const isBusy = updatingId === movie.kinopoiskId || removingId === movie.kinopoiskId
                  return (
                    <div className="my-movies-btn-group">
                      <button
                        className="my-movies-watched-btn"
                        onClick={() => handleMarkWatched(movie)}
                        disabled={isBusy}
                        title="Отметить просмотренным"
                      >
                        <Check size={20} />
                      </button>
                      <button
                        className="my-movies-remove-btn"
                        onClick={() => handleRemove(movie)}
                        disabled={isBusy}
                        title="Убрать из списка"
                      >
                        <X size={20} />
                      </button>
                    </div>
                  )
                })()}
              </div>
            ))}
          </div>

          {totalPages > 1 && (
            <div className="my-series-pagination">
              <button
                type="button"
                className="my-series-page-btn"
                onClick={() => handlePageChange(Math.max(1, pageClamped - 1))}
                disabled={pageClamped === 1}
              >
                <ChevronLeft size={16} /> Назад
              </button>
              <span className="my-series-page-info">
                Страница {pageClamped} из {totalPages}
              </span>
              <button
                type="button"
                className="my-series-page-btn"
                onClick={() => handlePageChange(Math.min(totalPages, pageClamped + 1))}
                disabled={pageClamped === totalPages}
              >
                Вперёд <ChevronRight size={16} />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}