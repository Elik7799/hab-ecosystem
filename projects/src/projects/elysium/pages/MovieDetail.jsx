import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useAuth } from '../context/ElysiumAuthContext'
import { getMovieName } from '../../../utils/ElysiumMovieName'
import { MovieDetailSkeleton } from '../components/ElysiumSkeleton'
import { showError } from '../../../utils/ElysiumToast'

const API_URL_BACKEND = 'https://hab-ecosystem.onrender.com/api'

const STATUSES = [
  { value: 'not_watched', label: 'Не смотрел' },
  { value: 'want_to_watch', label: 'Буду смотреть' },
  { value: 'watched', label: 'Посмотрел' },
]

const RELATED_TYPES = ['SEQUEL', 'PREQUEL', 'REMAKE']

function stripHtml(html) {
  const div = document.createElement('div')
  div.innerHTML = html
  return div.textContent || div.innerText || ''
}

function sortByYear(items) {
  return [...items].sort((a, b) => {
    const yearA = a.year || Infinity
    const yearB = b.year || Infinity
    return yearA - yearB
  })
}

export default function ElysiumMovieDetail() {
  const { id } = useParams()
  const { token } = useAuth()

  const [movie, setMovie] = useState(null)
  const [facts, setFacts] = useState([])
  const [relations, setRelations] = useState([])
  const [similars, setSimilars] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('not_watched')
  const [factsExpanded, setFactsExpanded] = useState(false)
  const [relatedStatuses, setRelatedStatuses] = useState({})

  useEffect(() => {
    if (!id || !token) return

    setLoading(true)
    setError('')
    setMovie(null)

    const authHeaders = {
      Authorization: `Bearer ${token}`,
    }

    const fetchMovie = fetch(`${API_URL_BACKEND}/kinopoisk/${id}`, {
      headers: authHeaders,
    }).then((res) => {
      if (!res.ok) throw new Error('Ошибка загрузки фильма')
      return res.json()
    })

    const fetchFacts = fetch(`${API_URL_BACKEND}/kinopoisk/${id}/facts`, {
      headers: authHeaders,
    })
      .then((res) => (res.ok ? res.json() : { items: [] }))
      .catch(() => ({ items: [] }))

    const fetchRelations = fetch(
      `${API_URL_BACKEND}/kinopoisk/${id}/relations`,
      { headers: authHeaders }
    )
      .then((res) => (res.ok ? res.json() : { items: [] }))
      .catch(() => ({ items: [] }))

    const fetchSimilars = fetch(
      `${API_URL_BACKEND}/kinopoisk/${id}/similars`,
      { headers: authHeaders }
    )
      .then((res) => (res.ok ? res.json() : { items: [] }))
      .catch(() => ({ items: [] }))

    const fetchStatus = fetch(`${API_URL_BACKEND}/movies/${id}`, {
      headers: authHeaders,
    })
      .then((res) => (res.ok ? res.json() : { status: 'not_watched' }))
      .catch(() => ({ status: 'not_watched' }))

    Promise.all([
      fetchMovie,
      fetchFacts,
      fetchRelations,
      fetchSimilars,
      fetchStatus,
    ])
      .then(([movieData, factsData, relationsData, similarsData, statusData]) => {
        if (!movieData || !movieData.kinopoiskId) {
          throw new Error('Фильм не найден')
        }

        setMovie(movieData)
        setFacts(factsData.items || [])
        setStatus(statusData.status)

        const allRelations = relationsData.items || []
        const allSimilars = similarsData.items || []

        const related = sortByYear(
          allRelations.filter(
            (item) => item && RELATED_TYPES.includes(item.relationType)
          )
        )

        const similarsFromRelations = allRelations.filter(
          (item) => item && item.relationType === 'SIMILAR'
        )

        const combinedSimilars = [...similarsFromRelations, ...allSimilars]
        const uniqueSimilars = Array.from(
          new Map(
            combinedSimilars.filter(Boolean).map((item) => [
              item.kinopoiskId || item.filmId,
              item,
            ])
          ).values()
        )

        setRelations(related)
        setSimilars(sortByYear(uniqueSimilars))

        const allIds = [...related, ...uniqueSimilars]
          .map((m) => m && (m.kinopoiskId || m.filmId))
          .filter(Boolean)

        if (allIds.length > 0) {
          fetch(`${API_URL_BACKEND}/movies/bulk-statuses`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ movieIds: allIds }),
          })
            .then((res) => (res.ok ? res.json() : { statuses: {} }))
            .then((statusesData) => setRelatedStatuses(statusesData.statuses || {}))
            .catch((err) => console.warn('Не удалось загрузить статусы:', err))
        }
      })
      .catch((err) => {
        console.error(err)
        setError('Не удалось загрузить информацию о фильме.')
        showError('Ошибка загрузки фильма')
      })
      .finally(() => setLoading(false))
  }, [id, token])

  const handleStatusChange = async (newStatus) => {
    if (!token) return

    const previousStatus = status
    setStatus(newStatus)

    try {
      const res = await fetch(`${API_URL_BACKEND}/movies/${id}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ status: newStatus }),
      })

      if (!res.ok) {
        setStatus(previousStatus)
        showError('Не удалось сохранить статус')
        console.error('Не удалось сохранить статус')
      }
    } catch (err) {
      setStatus(previousStatus)
      showError('Не удалось сохранить статус')
      console.error(err)
    }
  }

  // ЗАЩИТА ОТ БЕЛОГО ЭКРАНА
  if (loading) {
    return <MovieDetailSkeleton />
  }

  if (error || !movie) {
    return (
      <div className="moviedetail-error">
        <p>{error || 'Фильм не найден'}</p>
        <Link to="/elysium" className="loginbutton">
          Вернуться на главную
        </Link>
      </div>
    )
  }

  const genres = movie.genres?.map((g) => g.genre).join(', ') || '—'
  const countries = movie.countries?.map((c) => c.country).join(', ') || '—'

  const visibleFacts = factsExpanded ? facts : facts.slice(0, 3)

  const renderMovieCard = (item, idField) => {
    if (!item) return null
    const movieId = item[idField]
    if (!movieId) return null

    const itemStatus = relatedStatuses[movieId] || 'not_watched'

    return (
      <Link
        key={movieId}
        to={`/elysium/movie/${movieId}`}
        className={`moviedetail-moviecard moviedetail-moviecardhorizontal status-${itemStatus}`}
      >
        <img
          src={item.posterUrlPreview || item.posterUrl || 'https://kinopoiskapiunofficial.tech/images/posters/kp/no-poster.png'}
          alt={getMovieName(item) || 'Без названия'}
          className="moviedetail-movieposter"
          loading="lazy"
          onError={(e) => { e.target.src = 'https://kinopoiskapiunofficial.tech/images/posters/kp/no-poster.png' }}
        />
        <div className="moviedetail-movieinfo">
          <p className="moviedetail-moviename">{getMovieName(item) || 'Без названия'}</p>
        </div>
      </Link>
    )
  }

  return (
    <div className="moviedetail">
      <div className="moviedetail-top">
        <div className="moviedetail-poster">
          <img
            src={movie.posterUrl || movie.posterUrlPreview || 'https://kinopoiskapiunofficial.tech/images/posters/kp/no-poster.png'}
            alt={getMovieName(movie) || 'Без названия'}
            onError={(e) => { e.target.src = 'https://kinopoiskapiunofficial.tech/images/posters/kp/no-poster.png' }}
          />
        </div>

        <div className="moviedetail-info">
          <h1 className="moviedetail-title">{getMovieName(movie)}</h1>
          {movie.nameEn && movie.nameRu && (
            <p className="moviedetail-subtitle">{movie.nameEn}</p>
          )}

          <div className="moviedetail-meta">
            {movie.year && <span>{movie.year}</span>}
            {movie.filmLength && <span>{movie.filmLength} мин</span>}
            {movie.ratingKinopoisk && (
              <span className="moviedetail-rating">
                ★ {movie.ratingKinopoisk}
              </span>
            )}
          </div>

          <div className="moviedetail-statuses">
            {STATUSES.map((s) => (
              <button
                key={s.value}
                className={
                  status === s.value
                    ? 'moviedetail-statusbtn moviedetail-statusbtnactive'
                    : 'moviedetail-statusbtn'
                }
                onClick={() => handleStatusChange(s.value)}
              >
                {s.label}
              </button>
            ))}
          </div>

          <p className="moviedetail-description">
            {movie.description || 'Описание отсутствует.'}
          </p>
        </div>
      </div>

      <div className="moviedetail-details">
        <h2 className="moviedetail-heading">Детали</h2>
        <div className="moviedetail-grid">
          <div className="moviedetail-item">
            <span className="moviedetail-label">Жанры</span>
            <span className="moviedetail-value">{genres}</span>
          </div>
          <div className="moviedetail-item">
            <span className="moviedetail-label">Страны</span>
            <span className="moviedetail-value">{countries}</span>
          </div>
          <div className="moviedetail-item">
            <span className="moviedetail-label">Длительность</span>
            <span className="moviedetail-value">
              {movie.filmLength ? `${movie.filmLength} мин` : '—'}
            </span>
          </div>
          <div className="moviedetail-item">
            <span className="moviedetail-label">Рейтинг Кинопоиск</span>
            <span className="moviedetail-value">
              {movie.ratingKinopoisk || '—'}
            </span>
          </div>
          <div className="moviedetail-item">
            <span className="moviedetail-label">Рейтинг IMDb</span>
            <span className="moviedetail-value">
              {movie.ratingImdb || '—'}
            </span>
          </div>
          <div className="moviedetail-item">
            <span className="moviedetail-label">Слоган</span>
            <span className="moviedetail-value">{movie.slogan || '—'}</span>
          </div>
        </div>
      </div>

      {facts.length > 0 && (
        <div className="moviedetail-facts">
          <h2 className="moviedetail-heading">Факты</h2>
          <ul className="moviedetail-facts-list">
            {visibleFacts.map((fact, index) => (
              <li key={index} className="moviedetail-fact">
                {stripHtml(fact.text)}
              </li>
            ))}
          </ul>

          {facts.length > 3 && (
            <button
              className="moviedetail-toggle"
              onClick={() => setFactsExpanded((prev) => !prev)}
            >
              {factsExpanded ? 'Свернуть' : `Показать все (${facts.length})`}
            </button>
          )}
        </div>
      )}

      {relations.length > 0 && (
        <div className="moviedetail-similars">
          <h2 className="moviedetail-heading">Связанные фильмы</h2>
          <div className="moviedetail-moviesscroll">
            {relations.map((item) => renderMovieCard(item, 'kinopoiskId'))}
          </div>
        </div>
      )}

      {similars.length > 0 && (
        <div className="moviedetail-similars">
          <h2 className="moviedetail-heading">Похожие</h2>
          <div className="moviedetail-moviesscroll">
            {similars.map((item) => renderMovieCard(item, 'filmId'))}
          </div>
        </div>
      )}

      <Link to="/elysium" className="moviedetail-back">
        ← Назад
      </Link>
    </div>
  )
}