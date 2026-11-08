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
  return [...items].sort((a, b) => (a.year || Infinity) - (b.year || Infinity))
}

export default function ElysiumMovieDetail({ dbType = 'FILM' }) {
  const { id } = useParams()
  const { token } = useAuth()
  const isSeries = dbType === 'TV_SERIES'
  const pathType = isSeries ? 'tv' : 'movie'

  const [movie, setMovie] = useState(null)
  const [relations, setRelations] = useState([])
  const [similars, setSimilars] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('not_watched')
  const [relatedStatuses, setRelatedStatuses] = useState({})

  const [episodes, setEpisodes] = useState([])
  const [watchedEpisodes, setWatchedEpisodes] = useState({})
  const [expandedSeasons, setExpandedSeasons] = useState({})

  useEffect(() => {
    if (!id || !token) return

    setLoading(true)
    setError('')
    setMovie(null)

    const h = { Authorization: `Bearer ${token}` }

    const fetchMovie = fetch(
      `${API_URL_BACKEND}/kinopoisk/${pathType}/${id}`, { headers: h }
    ).then(r => {
      if (!r.ok) throw new Error('Ошибка загрузки')
      return r.json()
    })

    const fetchRelations = fetch(
      `${API_URL_BACKEND}/kinopoisk/${pathType}/${id}/relations`, { headers: h }
    ).then(r => (r.ok ? r.json() : { items: [] })).catch(() => ({ items: [] }))

    const fetchSimilars = fetch(
      `${API_URL_BACKEND}/kinopoisk/${pathType}/${id}/similars`, { headers: h }
    ).then(r => (r.ok ? r.json() : { items: [] })).catch(() => ({ items: [] }))

    const fetchStatus = fetch(
      `${API_URL_BACKEND}/movies/${pathType}/${id}`, { headers: h }
    ).then(r => (r.ok ? r.json() : { status: 'not_watched' }))
      .catch(() => ({ status: 'not_watched' }))

    Promise.all([fetchMovie, fetchRelations, fetchSimilars, fetchStatus])
      .then(([movieData, relData, simData, statusData]) => {
        if (!movieData || !movieData.kinopoiskId) throw new Error('Не найдено')
        setMovie(movieData)
        setStatus(statusData.status)

        const rel = sortByYear((relData.items || []).filter(i =>
          i && RELATED_TYPES.includes(i.relationType)
        ))
        const sims = sortByYear(
          Array.from(
            new Map(
              (simData.items || []).filter(Boolean).map(i => [i.kinopoiskId, i])
            ).values()
          )
        )
        setRelations(rel)
        setSimilars(sims)

        const refs = [...rel, ...sims].map(i => ({
          tmdbId: i.kinopoiskId,
          type: i.type || 'FILM',
        })).filter(r => r.tmdbId)

        if (refs.length > 0) {
          fetch(`${API_URL_BACKEND}/movies/bulk-statuses`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...h },
            body: JSON.stringify({ refs }),
          })
            .then(r => (r.ok ? r.json() : { statuses: {} }))
            .then(d => setRelatedStatuses(d.statuses || {}))
            .catch(() => { })
        }
      })
      .catch(err => {
        console.error(err)
        setError('Не удалось загрузить информацию.')
        showError('Ошибка загрузки')
      })
      .finally(() => setLoading(false))
  }, [id, token, pathType])

  useEffect(() => {
    if (!movie || movie.type !== 'TV_SERIES' || !token) return

    (async () => {
      try {
        const h = { Authorization: `Bearer ${token}` }
        const res = await fetch(
          `${API_URL_BACKEND}/kinopoisk/tv/${id}/seasons`, { headers: h }
        )
        const data = await res.json()
        setEpisodes(data.episodes || [])

        const wr = await fetch(
          `${API_URL_BACKEND}/kinopoisk/tv/${id}/watched-episodes`, { headers: h }
        )
        if (wr.ok) {
          const wd = await wr.json()
          const m = {}
          wd.episodes?.forEach(e => { m[`${e.season_number}-${e.episode_number}`] = true })
          setWatchedEpisodes(m)
        }
      } catch (err) {
        console.error('Seasons:', err)
      }
    })()
  }, [movie, id, token])

  const handleStatusChange = async (newStatus) => {
    if (!token) return
    const prev = status
    setStatus(newStatus)
    try {
      const res = await fetch(
        `${API_URL_BACKEND}/movies/${pathType}/${id}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ status: newStatus }),
        }
      )
      if (!res.ok) {
        setStatus(prev)
        const d = await res.json()
        showError(d.error || 'Не удалось сохранить')
        return
      }
      // Сервер мог вернуть другой статус (например, watching → watched при автопереоценке)
      const data = await res.json()
      if (data?.status && data.status !== newStatus) {
        setStatus(data.status)
      }
    } catch {
      setStatus(prev)
      showError('Не удалось сохранить')
    }
  }
  const handleToggleEpisode = async (seasonNumber, episodeNumber) => {
    const key = `${seasonNumber}-${episodeNumber}`
    const isWatched = watchedEpisodes[key]
    setWatchedEpisodes(p => ({ ...p, [key]: !isWatched }))
    try {
      const res = await fetch(`${API_URL_BACKEND}/episodes/toggle`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          movieId: parseInt(id),
          seasonNumber, episodeNumber,
          watched: !isWatched,
        }),
      })
      if (res.ok) {
        const d = await res.json()
        setStatus(d.newStatus)
      }
    } catch {
      setWatchedEpisodes(p => ({ ...p, [key]: isWatched }))
    }
  }

  const handleBulkToggleSeason = async (seasonNum, action) => {
    const seasonEps = episodes.filter(e => e.season_number === seasonNum)
    const aired = seasonEps.filter(e =>
      e.release_date ? new Date(e.release_date) <= new Date() : false
    )
    if (aired.length === 0) return
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
          episodes: aired,
          watched: action === 'watch',
        }),
      })
      if (res.ok) {
        const d = await res.json()
        setStatus(d.newStatus)
        setWatchedEpisodes(prev => {
          const next = { ...prev }
          aired.forEach(ep => {
            const k = `${ep.season_number}-${ep.episode_number}`
            if (action === 'watch') next[k] = true
            else delete next[k]
          })
          return next
        })
      }
    } catch {
      showError('Ошибка')
    }
  }

  const toggleSeason = (n) => {
    setExpandedSeasons(p => ({ ...p, [n]: !p[n] }))
  }

  if (loading) return <MovieDetailSkeleton />

  if (error || !movie) {
    return (
      <div className="moviedetail-error">
        <p>{error || 'Не найдено'}</p>
        <Link to="/elysium" className="loginbutton">Вернуться</Link>
      </div>
    )
  }

  const genres = movie.genres?.map(g => g.genre).join(', ') || '—'
  const countries = movie.countries?.map(c => c.country).join(', ') || '—'

  const renderCard = (item) => {
    if (!item?.kinopoiskId) return null
    const key = `${item.kinopoiskId}:${item.type || 'FILM'}`
    const st = relatedStatuses[key] || 'not_watched'
    const path = item.type === 'TV_SERIES' ? 'serial' : 'movie'
    return (
      <Link
        key={key}
        to={`/elysium/${path}/${item.kinopoiskId}`}
        className={`moviedetail-moviecard moviedetail-moviecardhorizontal status-${st}`}
      >
        <img
          src={item.posterUrlPreview || item.posterUrl || 'https://kinopoiskapiunofficial.tech/images/posters/kp/no-poster.png'}
          alt={getMovieName(item)}
          className="moviedetail-movieposter"
          loading="lazy"
          onError={e => { e.target.src = 'https://kinopoiskapiunofficial.tech/images/posters/kp/no-poster.png' }}
        />
        <div className="moviedetail-movieinfo">
          <p className="moviedetail-moviename">{getMovieName(item)}</p>
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
            alt={getMovieName(movie)}
            onError={e => { e.target.src = 'https://kinopoiskapiunofficial.tech/images/posters/kp/no-poster.png' }}
          />
        </div>

        <div className="moviedetail-info">
          <h1 className="moviedetail-title">{getMovieName(movie)}</h1>
          {movie.nameOriginal && movie.nameOriginal !== movie.nameRu && (
            <p className="moviedetail-subtitle">{movie.nameOriginal}</p>
          )}

          <div className="moviedetail-meta">
            {movie.year ? <span>{movie.year}</span> : null}
            {movie.filmLength ? <span>{movie.filmLength} мин</span> : null}
            {movie.ratingKinopoisk ? (
              <span className="moviedetail-rating">★ {movie.ratingKinopoisk}</span>
            ) : null}
          </div>

          <div className="moviedetail-statuses">
            {(() => {
              const watchedCount = Object.keys(watchedEpisodes)
                .filter(k => watchedEpisodes[k]).length
              const airedEpisodes = isSeries ? episodes.filter(e =>
                e.release_date ? new Date(e.release_date) <= new Date() : false
              ) : []
              const airedCount = airedEpisodes.length
              const allAiredWatched = isSeries && airedCount > 0 && airedEpisodes.every(
                e => watchedEpisodes[`${e.season_number}-${e.episode_number}`]
              )
              const hasSomeWatched = isSeries && watchedCount > 0
              const hasUnwatched = isSeries && airedCount > 0 && watchedCount < airedCount
              const showDropped = hasSomeWatched && hasUnwatched
              const isWatchedFinal = isSeries && status === 'watched'

              return STATUSES.map(s => {
                if (isSeries && s.value === 'watched') {
                  // Активный индикатор «Посмотрел», когда все вышедшие серии просмотрены
                  if (status === 'watched') {
                    return (
                      <button
                        key={s.value}
                        className="moviedetail-statusbtn moviedetail-statusbtnactive"
                        disabled
                      >
                        {s.label}
                      </button>
                    )
                  }
                  return null
                }

                const disNot = s.value === 'not_watched' && hasSomeWatched
                const disWant = s.value === 'want_to_watch' && allAiredWatched
                const dis = disNot || disWant
                let hint = ''
                if (disNot) hint = 'Сначала снимите отметки с серий'
                else if (disWant) hint = 'Все серии уже просмотрены'
                return (
                  <button
                    key={s.value}
                    className={status === s.value
                      ? 'moviedetail-statusbtn moviedetail-statusbtnactive'
                      : 'moviedetail-statusbtn'}
                    onClick={() => { if (dis) { showError(hint); return } handleStatusChange(s.value) }}
                    style={dis ? { opacity: 0.4, cursor: 'not-allowed' } : {}}
                    title={dis ? hint : ''}
                  >
                    {s.label}
                  </button>
                )
              }).concat(
                isSeries ? [
                  (() => {
                    // Когда сериал уже в watched — кнопку «Смотрю» не показываем:
                    // всё просмотрено, нечего продолжать. Как только выйдут новые серии,
                    // getStatus при заходе переведёт обратно в watching, и кнопка вернётся.
                    if (isWatchedFinal) return null

                    const disWatching = allAiredWatched
                    const hintWatching = disWatching
                      ? 'Все вышедшие серии просмотрены'
                      : ''
                    return (
                      <button
                        key="watching"
                        className={status === 'watching'
                          ? 'moviedetail-statusbtn moviedetail-statusbtnactive'
                          : 'moviedetail-statusbtn'}
                        onClick={() => {
                          if (disWatching) { showError(hintWatching); return }
                          handleStatusChange('watching')
                        }}
                        style={disWatching ? { opacity: 0.4, cursor: 'not-allowed' } : {}}
                        title={hintWatching}
                      >
                        Смотрю
                      </button>
                    )
                  })(),
                  showDropped || status === 'dropped' ? (
                    <button
                      key="dropped"
                      className={status === 'dropped'
                        ? 'moviedetail-statusbtn moviedetail-statusbtnactive status-dropped-btn'
                        : 'moviedetail-statusbtn status-dropped-btn'}
                      onClick={() => handleStatusChange('dropped')}
                      title="Убрать из «Смотрю» и сохранить прогресс"
                    >
                      Перестал смотреть
                    </button>
                  ) : null,
                ].filter(Boolean) : []
              )
            })()}
          </div>

          <p className="moviedetail-description">{movie.description || 'Описание отсутствует.'}</p>
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
            <span className="moviedetail-value">{movie.filmLength ? `${movie.filmLength} мин` : '—'}</span>
          </div>
          <div className="moviedetail-item">
            <span className="moviedetail-label">Рейтинг</span>
            <span className="moviedetail-value">{movie.ratingKinopoisk || '—'}</span>
          </div>
          <div className="moviedetail-item">
            <span className="moviedetail-label">Слоган</span>
            <span className="moviedetail-value">{movie.slogan || '—'}</span>
          </div>
        </div>
      </div>

      {isSeries && episodes.length > 0 && (
        <div className="moviedetail-seasons">
          <h2 className="moviedetail-heading">Сезоны</h2>
          {Array.from(new Set(episodes.map(e => e.season_number))).map(seasonNum => {
            const isExpanded = expandedSeasons[seasonNum]
            const seasonEps = episodes.filter(e => e.season_number === seasonNum)
            const wc = seasonEps.filter(e => watchedEpisodes[`${e.season_number}-${e.episode_number}`]).length
            return (
              <div key={seasonNum} className="season-block">
                <div className="season-header" onClick={() => toggleSeason(seasonNum)}>
                  <h3 className="season-title">
                    Сезон {seasonNum}
                    <span className="season-progress">({wc} / {seasonEps.length})</span>
                  </h3>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    {(() => {
                      const aired = seasonEps.filter(e =>
                        e.release_date ? new Date(e.release_date) <= new Date() : false
                      )
                      const allW = aired.length > 0 && aired.every(e =>
                        watchedEpisodes[`${e.season_number}-${e.episode_number}`]
                      )
                      if (aired.length === 0 || allW) return null
                      return (
                        <button
                          type="button"
                          className="season-bulk-btn"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleBulkToggleSeason(seasonNum, 'watch')
                          }}
                        >
                          <Check size={14} /> Отметить сезон
                        </button>
                      )
                    })()}
                    <span className="season-toggle-icon">{isExpanded ? '▲' : '▼'}</span>
                  </div>
                </div>
                {isExpanded && (
                  <div className="episodes-list">
                    {seasonEps.map(ep => {
                      const key = `${ep.season_number}-${ep.episode_number}`
                      const isW = watchedEpisodes[key]
                      const isAired = ep.release_date ? new Date(ep.release_date) <= new Date() : false
                      return (
                        <div
                          key={key}
                          className={`episode-item ${isW ? 'watched' : ''} ${!isAired ? 'not-aired' : ''}`}
                          onClick={() => isAired && handleToggleEpisode(ep.season_number, ep.episode_number)}
                        >
                          <div className="episode-checkbox">{isW && <Check size={16} />}</div>
                          <div className="episode-info">
                            <span className="episode-name-main">
                              {ep.name_ru || `Серия ${ep.episode_number}`}
                            </span>
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

      {relations.length > 0 && (
        <div className="moviedetail-similars">
          <h2 className="moviedetail-heading">Связанные</h2>
          <div className="moviedetail-moviesscroll">
            {relations.map(renderCard)}
          </div>
        </div>
      )}

      {similars.length > 0 && (
        <div className="moviedetail-similars">
          <h2 className="moviedetail-heading">Похожие</h2>
          <div className="moviedetail-moviesscroll">
            {similars.map(renderCard)}
          </div>
        </div>
      )}

      <Link to="/elysium" className="moviedetail-back">← Назад</Link>
    </div>
  )
}