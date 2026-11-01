import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useAuth } from '../context/ElysiumAuthContext'
import { getMovieName } from '../../../utils/ElysiumMovieName'
import { MovieDetailSkeleton } from '../components/ElysiumSkeleton'
import { showError } from '../../../utils/ElysiumToast'
import { Check } from 'lucide-react'

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

  const [episodes, setEpisodes] = useState([])
  const [watchedEpisodes, setWatchedEpisodes] = useState({})
  const [expandedSeasons, setExpandedSeasons] = useState({})

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

  useEffect(() => {
    if (!movie || (movie.type !== 'TV_SERIES' && movie.type !== 'MINI_SERIES')) return

    const fetchSeasons = async () => {
      try {
        const res = await fetch(`${API_URL_BACKEND}/kinopoisk/${id}/seasons`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        const data = await res.json()
        setEpisodes(data.episodes || [])

        // Загружаем отмеченные серии
        const watchedRes = await fetch(`${API_URL_BACKEND}/kinopoisk/${id}/watched-episodes`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (watchedRes.ok) {
          const watchedData = await watchedRes.json()
          const watchedMap = {}
          watchedData.episodes?.forEach((ep) => {
            watchedMap[`${ep.season_number}-${ep.episode_number}`] = true
          })
          setWatchedEpisodes(watchedMap)
        }
      } catch (err) {
        console.error('Ошибка загрузки серий:', err)
      }
    }

    fetchSeasons()
  }, [movie, id, token])

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

  const handleToggleEpisode = async (seasonNumber, episodeNumber) => {
    const key = `${seasonNumber}-${episodeNumber}`
    const isWatched = watchedEpisodes[key]

    // Оптимистичное обновление
    setWatchedEpisodes((prev) => ({ ...prev, [key]: !isWatched }))

    try {
      const res = await fetch(`${API_URL_BACKEND}/episodes/toggle`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          movieId: parseInt(id),
          seasonNumber,
          episodeNumber,
          watched: !isWatched,
        }),
      })

      if (res.ok) {
        const data = await res.json()
        setStatus(data.newStatus) // Обновляем статус кнопки
      }
    } catch (err) {
      console.error(err)
      // Откатываем при ошибке
      setWatchedEpisodes((prev) => ({ ...prev, [key]: isWatched }))
    }
  }
  const handleBulkToggleSeason = async (seasonNum, action) => {
    const seasonEpisodes = episodes.filter((e) => e.season_number === seasonNum)

    // Фильтруем только вышедшие серии
    const airedEpisodes = seasonEpisodes.filter((e) =>
      e.release_date ? new Date(e.release_date) <= new Date() : false
    )

    if (airedEpisodes.length === 0) return

    try {
      const res = await fetch(`${API_URL_BACKEND}/episodes/bulk-toggle`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          movieId: parseInt(id),
          seasonNumber: seasonNum,
          episodes: airedEpisodes,
          watched: action === 'watch',
        }),
      })

      if (res.ok) {
        const data = await res.json()
        setStatus(data.newStatus)

        // Обновляем локальный стейт watchedEpisodes
        setWatchedEpisodes((prev) => {
          const next = { ...prev }
          airedEpisodes.forEach((ep) => {
            const key = `${ep.season_number}-${ep.episode_number}`
            if (action === 'watch') {
              next[key] = true
            } else {
              delete next[key]
            }
          })
          return next
        })
      }
    } catch (err) {
      console.error(err)
      showError('Ошибка отметки сезона')
    }
  }

  const toggleSeason = (seasonNum) => {
    setExpandedSeasons((prev) => ({
      ...prev,
      [seasonNum]: !prev[seasonNum],
    }))
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
            {STATUSES.map((s) => {
              // Скрываем кнопку "Посмотрел", если это сериал
              const isSeries = movie.type === 'TV_SERIES' || movie.type === 'MINI_SERIES'
              if (isSeries && s.value === 'watched') return null

              // Для сериалов "Не смотрел" и "Буду смотреть"
              return (
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
              )
            })}

            {/* Для сериалов добавляем кнопку "Смотрю" */}
            {movie.type === 'TV_SERIES' || movie.type === 'MINI_SERIES' ? (
              <button
                className={
                  status === 'watching' || status === 'watched'
                    ? 'moviedetail-statusbtn moviedetail-statusbtnactive'
                    : 'moviedetail-statusbtn'
                }
                onClick={() => handleStatusChange('watching')}
              >
                {status === 'watched' ? 'Посмотрел' : 'Смотрю'}
              </button>
            ) : null}
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

      {episodes.length > 0 && (
        <div className="moviedetail-seasons">
          <h2 className="moviedetail-heading">Сезоны</h2>
          {Array.from(new Set(episodes.map((e) => e.season_number))).map((seasonNum) => {
            const isExpanded = expandedSeasons[seasonNum]
            const seasonEpisodes = episodes.filter((e) => e.season_number === seasonNum)
            const watchedCount = seasonEpisodes.filter(
              (e) => watchedEpisodes[`${e.season_number}-${e.episode_number}`]
            ).length

            return (
              <div key={seasonNum} className="season-block">
                <div className="season-header" onClick={() => toggleSeason(seasonNum)}>
                  <h3 className="season-title">
                    Сезон {seasonNum}
                    <span className="season-progress">
                      ({watchedCount} / {seasonEpisodes.length})
                    </span>
                  </h3>

                  {/* НОВАЯ КНОПКА */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    {(() => {
                      // Считаем, есть ли непросмотренные вышедшие серии
                      const airedEpisodes = seasonEpisodes.filter(e =>
                        e.release_date ? new Date(e.release_date) <= new Date() : false
                      )
                      const allAiredWatched = airedEpisodes.length > 0 && airedEpisodes.every(
                        e => watchedEpisodes[`${e.season_number}-${e.episode_number}`]
                      )

                      if (airedEpisodes.length === 0 || allAiredWatched) return null

                      return (
                        <button
                          type="button"
                          className="season-bulk-btn"
                          onClick={(e) => {
                            e.stopPropagation() // Чтобы не срабатывало сворачивание сезона
                            handleBulkToggleSeason(seasonNum, 'watch')
                          }}
                          title="Отметить все вышедшие серии просмотренными"
                        >
                          <Check size={14} />
                          Отметить сезон
                        </button>
                      )
                    })()}

                    <span className="season-toggle-icon">
                      {isExpanded ? '▲' : '▼'}
                    </span>
                  </div>
                </div>

                {isExpanded && (
                  <div className="episodes-list">
                    {seasonEpisodes.map((ep) => {
                      const key = `${ep.season_number}-${ep.episode_number}`
                      const isWatched = watchedEpisodes[key]
                      const isAired = ep.release_date ? new Date(ep.release_date) <= new Date() : false

                      return (
                        <div
                          key={key}
                          className={`episode-item ${isWatched ? 'watched' : ''} ${!isAired ? 'not-aired' : ''}`}
                          onClick={() => isAired && handleToggleEpisode(ep.season_number, ep.episode_number)}
                        >
                          <div className="episode-checkbox">
                            {isWatched && <Check size={16} />}
                          </div>
                          <div className="episode-info">
                            {/* НАЗВАНИЕ СЕРИИ ТЕПЕРЬ ГЛАВНОЕ */}
                            <span className="episode-name-main">
                              {ep.name_ru || `Серия ${ep.episode_number}`}
                            </span>
                            {/* НОМЕР И ДАТА ВТОРИЧНЫ */}
                            <span className="episode-subtitle">
                              Серия {ep.episode_number}
                              {ep.release_date && ` · ${new Date(ep.release_date).toLocaleDateString('ru-RU')}`}
                            </span>
                            {!isAired && <span className="episode-status">Еще не вышла</span>}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

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