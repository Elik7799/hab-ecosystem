import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/ElysiumAuthContext'
import { getMovieName, getMoviePath } from '../../../utils/ElysiumMovieName'
import { showSuccess, showError } from '../../../utils/ElysiumToast'
import { Check, ArrowDownUp, Clock, Star } from 'lucide-react'

const API_URL_BACKEND = 'https://hab-ecosystem.onrender.com/api'

const SORT_OPTIONS = [
  { value: 'name_asc', label: 'По названию (А-Я)' },
  { value: 'name_desc', label: 'По названию (Я-А)' },
  { value: 'year_desc', label: 'По году (новые-старые)' },
  { value: 'year_asc', label: 'По году (старые-новые)' },
]

export default function ElysiumMyMovies() {
  const { token } = useAuth()
  const [movies, setMovies] = useState([])
  const [loading, setLoading] = useState(true)
  const [updatingId, setUpdatingId] = useState(null)
  const [sortBy, setSortBy] = useState(() => localStorage.getItem('my-movies-sort') || 'name_asc')

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

  useEffect(() => { fetchMovies() }, [token])
  useEffect(() => { localStorage.setItem('my-movies-sort', sortBy) }, [sortBy])

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
      default: return 0
    }
  })

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
          <select value={sortBy} onChange={e => setSortBy(e.target.value)} className="my-series-sort-select">
            {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>

      {movies.length === 0 ? (
        <p className="my-series-empty">
          У вас пока нет фильмов в статусе «Буду смотреть».{' '}
          <Link to="/elysium" className="my-series-link">Найти фильм</Link>
        </p>
      ) : (
        <div className="my-movies-list">
          {sorted.map(movie => (
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
              <button
                className="my-movies-watched-btn"
                onClick={() => handleMarkWatched(movie)}
                disabled={updatingId === movie.kinopoiskId}
                title="Отметить просмотренным"
              >
                <Check size={20} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}