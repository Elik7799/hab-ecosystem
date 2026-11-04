import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/ElysiumAuthContext'
import { getMovieName } from '../../../utils/ElysiumMovieName'
import { showSuccess, showError } from '../../../utils/ElysiumToast'
import { Check, ArrowDownUp, Play, Star } from 'lucide-react'

const API_URL_BACKEND = 'https://hab-ecosystem.onrender.com/api'

const SORT_OPTIONS = [
  { value: 'name_asc', label: 'По названию (А-Я)' },
  { value: 'name_desc', label: 'По названию (Я-А)' },
  { value: 'year_desc', label: 'По году (новые-старые)' },
  { value: 'year_asc', label: 'По году (старые-новые)' },
  { value: 'ep_date_desc', label: 'По дате выхода серии (новые-старые)' },
  { value: 'ep_date_asc', label: 'По дате выхода серии (старые-новые)' },
  { value: 'remaining_asc', label: 'По остатку серий (меньше-больше)' },
  { value: 'remaining_desc', label: 'По остатку серий (больше-меньше)' },
]

const PLANNED_SORT_OPTIONS = [
  { value: 'name_asc', label: 'По названию (А-Я)' },
  { value: 'name_desc', label: 'По названию (Я-А)' },
  { value: 'year_desc', label: 'По году (новые-старые)' },
  { value: 'year_asc', label: 'По году (старые-новые)' },
  { value: 'episodes_desc', label: 'По кол-ву серий (больше-меньше)' },
  { value: 'episodes_asc', label: 'По кол-ву серий (меньше-больше)' },
]

export default function ElysiumMySeries() {
  const { token } = useAuth()

  // Верхний список (Смотрю)
  const [series, setSeries] = useState([])
  const [loading, setLoading] = useState(true)
  const [updatingId, setUpdatingId] = useState(null)
  const [sortBy, setSortBy] = useState(
    () => localStorage.getItem('my-series-sort') || 'name_asc'
  )

  // Нижний список (Буду смотреть)
  const [plannedSeries, setPlannedSeries] = useState([])
  const [plannedSortBy, setPlannedSortBy] = useState(
    () => localStorage.getItem('my-planned-series-sort') || 'name_asc'
  )

  const fetchSeries = async () => {
    if (!token) return
    try {
      const res = await fetch(`${API_URL_BACKEND}/users/me/watching`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) {
        const data = await res.json()
        setSeries(data.series || [])
      }
    } catch (err) {
      console.error(err)
      showError('Ошибка загрузки сериалов')
    }
  }

  const fetchPlannedSeries = async () => {
    if (!token) return
    try {
      const res = await fetch(`${API_URL_BACKEND}/users/me/watchlist-series`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) {
        const data = await res.json()
        setPlannedSeries(data.series || [])
      }
    } catch (err) {
      console.error(err)
    }
  }

  const loadAll = async () => {
    setLoading(true)
    await Promise.all([fetchSeries(), fetchPlannedSeries()])
    setLoading(false)
  }

  useEffect(() => {
    loadAll()
  }, [token])

  useEffect(() => {
    localStorage.setItem('my-series-sort', sortBy)
  }, [sortBy])

  useEffect(() => {
    localStorage.setItem('my-planned-series-sort', plannedSortBy)
  }, [plannedSortBy])

  const handleMarkWatched = async (show, season, episode) => {
    setUpdatingId(show.kinopoiskId)
    try {
      const res = await fetch(`${API_URL_BACKEND}/episodes/toggle`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          movieId: show.kinopoiskId,
          seasonNumber: season,
          episodeNumber: episode,
          watched: true,
        }),
      })

      if (res.ok) {
        showSuccess(`Серия ${season}x${episode} отмечена!`)
        await fetchSeries()
      } else {
        showError('Не удалось отметить серию')
      }
    } catch (err) {
      console.error(err)
      showError('Ошибка')
    } finally {
      setUpdatingId(null)
    }
  }

  const handleStartWatching = async (show) => {
    setUpdatingId(show.kinopoiskId)
    try {
      const res = await fetch(`${API_URL_BACKEND}/movies/${show.kinopoiskId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ status: 'watching' }),
      })

      if (res.ok) {
        showSuccess(`«${getMovieName(show)}» добавлен в «Смотрю»`)
        await Promise.all([fetchSeries(), fetchPlannedSeries()])
      } else {
        showError('Не удалось изменить статус')
      }
    } catch (err) {
      console.error(err)
      showError('Ошибка')
    } finally {
      setUpdatingId(null)
    }
  }

  // Сортировка верхнего списка
  const sortedSeries = [...series].sort((a, b) => {
    switch (sortBy) {
      case 'name_asc':
        return getMovieName(a).localeCompare(getMovieName(b), 'ru')
      case 'name_desc':
        return getMovieName(b).localeCompare(getMovieName(a), 'ru')
      case 'year_desc': {
        const diff = (b.year || 0) - (a.year || 0)
        if (diff !== 0) return diff
        return getMovieName(a).localeCompare(getMovieName(b), 'ru')
      }
      case 'year_asc': {
        const diff = (a.year || 0) - (b.year || 0)
        if (diff !== 0) return diff
        return getMovieName(a).localeCompare(getMovieName(b), 'ru')
      }
      case 'ep_date_desc': {
        const dateA = a.nextEpisodeDate ? new Date(a.nextEpisodeDate).getTime() : 0
        const dateB = b.nextEpisodeDate ? new Date(b.nextEpisodeDate).getTime() : 0
        return dateB - dateA
      }
      case 'ep_date_asc': {
        const dateA = a.nextEpisodeDate ? new Date(a.nextEpisodeDate).getTime() : Infinity
        const dateB = b.nextEpisodeDate ? new Date(b.nextEpisodeDate).getTime() : Infinity
        return dateA - dateB
      }
      case 'remaining_asc':
        return (a.remaining || 0) - (b.remaining || 0)
      case 'remaining_desc':
        return (b.remaining || 0) - (a.remaining || 0)
      default:
        return 0
    }
  })

  // Сортировка нижнего списка
  const sortedPlanned = [...plannedSeries].sort((a, b) => {
    switch (plannedSortBy) {
      case 'name_asc':
        return getMovieName(a).localeCompare(getMovieName(b), 'ru')
      case 'name_desc':
        return getMovieName(b).localeCompare(getMovieName(a), 'ru')
      case 'year_desc': {
        const diff = (b.year || 0) - (a.year || 0)
        if (diff !== 0) return diff
        return getMovieName(a).localeCompare(getMovieName(b), 'ru')
      }
      case 'year_asc': {
        const diff = (a.year || 0) - (b.year || 0)
        if (diff !== 0) return diff
        return getMovieName(a).localeCompare(getMovieName(b), 'ru')
      }
      case 'episodes_desc':
        return (b.remaining || 0) - (a.remaining || 0)
      case 'episodes_asc':
        return (a.remaining || 0) - (b.remaining || 0)
      default:
        return 0
    }
  })

  if (loading) {
    return (
      <div className="my-series-body">
        <h1 className="my-series-title">Мои сериалы</h1>
        <p className="my-series-empty">Загрузка...</p>
      </div>
    )
  }

  return (
    <div className="my-series-body">
      <div className="my-series-header-row">
        <div>
          <h1 className="my-series-title">Смотрю сейчас</h1>
          <p className="my-series-subtitle">Сериалы, которые вы сейчас смотрите</p>
        </div>

        <div className="my-series-sort">
          <ArrowDownUp size={16} />
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            className="my-series-sort-select"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {series.length === 0 ? (
        <p className="my-series-empty">
          У вас пока нет сериалов в статусе «Смотрю».
        </p>
      ) : (
        <div className="my-series-list">
          {sortedSeries.map((show) => (
            <div key={show.kinopoiskId} className="my-series-card">
              <Link to={`/elysium/movie/${show.kinopoiskId}`}>
                <img
                  src={show.posterUrlPreview || 'https://kinopoiskapiunofficial.tech/images/posters/kp/no-poster.png'}
                  alt={getMovieName(show)}
                  className="my-series-poster"
                  onError={(e) => { e.target.src = 'https://kinopoiskapiunofficial.tech/images/posters/kp/no-poster.png' }}
                />
              </Link>

              <div className="my-series-info">
                <Link to={`/elysium/movie/${show.kinopoiskId}`} className="my-series-name">
                  {getMovieName(show)}
                </Link>

                {show.totalAired === 0 ? (
                  <p className="my-series-done" style={{ color: '#888' }}>
                    Серии ещё не вышли
                  </p>
                ) : show.nextEpisode ? (
                  <div className="my-series-next">
                    <p className="my-series-next-label">Следующая серия:</p>
                    <p className="my-series-next-title">
                      {show.nextEpisodeName || `Сезон ${show.nextSeason}, Серия ${show.nextEpisode}`}
                    </p>
                    <p className="my-series-next-meta">
                      Сезон {show.nextSeason} · Серия {show.nextEpisode}
                    </p>
                    <button
                      className="my-series-btn"
                      onClick={() => handleMarkWatched(show, show.nextSeason, show.nextEpisode)}
                      disabled={updatingId === show.kinopoiskId}
                    >
                      <Check size={16} />
                      {updatingId === show.kinopoiskId ? 'Загрузка...' : 'Отметить просмотренной'}
                    </button>
                  </div>
                ) : (
                  <p className="my-series-done">Все вышедшие серии просмотрены!</p>
                )}
              </div>

              <div className="my-series-stats">
                <div className="my-series-stat">
                  <span className="my-series-stat-value">{show.remaining}</span>
                  <span className="my-series-stat-label">осталось</span>
                </div>
                <div className="my-series-progress-bar">
                  <div
                    className="my-series-progress-fill"
                    style={{ width: `${(show.watchedCount / (show.totalAired || 1)) * 100}%` }}
                  ></div>
                </div>
                <span className="my-series-progress-text">
                  {show.watchedCount} из {show.totalAired}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="my-series-header-row my-series-header-row-planned">
        <div>
          <h2 className="my-series-title">Буду смотреть</h2>
          <p className="my-series-subtitle">Сериалы, которые вы отложили на потом</p>
        </div>

        <div className="my-series-sort">
          <ArrowDownUp size={16} />
          <select
            value={plannedSortBy}
            onChange={(e) => setPlannedSortBy(e.target.value)}
            className="my-series-sort-select"
          >
            {PLANNED_SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {plannedSeries.length === 0 ? (
        <p className="my-series-empty">
          У вас пока нет сериалов в статусе «Буду смотреть».
        </p>
      ) : (
        <div className="my-series-list">
          {sortedPlanned.map((show) => (
            <div key={show.kinopoiskId} className="my-series-card my-series-card-planned">
              <Link to={`/elysium/movie/${show.kinopoiskId}`}>
                <img
                  src={show.posterUrlPreview || 'https://kinopoiskapiunofficial.tech/images/posters/kp/no-poster.png'}
                  alt={getMovieName(show)}
                  className="my-series-poster"
                  onError={(e) => { e.target.src = 'https://kinopoiskapiunofficial.tech/images/posters/kp/no-poster.png' }}
                />
              </Link>

              <div className="my-series-info">
                <Link to={`/elysium/movie/${show.kinopoiskId}`} className="my-series-name">
                  {getMovieName(show)}
                </Link>
                {show.nameOriginal && (
                  <p className="my-series-original">{show.nameOriginal}</p>
                )}
                <div className="my-series-meta-row">
                  {show.year && show.year !== 0 && (
                    <span>{show.year}</span>
                  )}

                  {show.ratingKinopoisk && show.ratingKinopoisk !== 0 && (
                    <span className="my-series-rating">
                      <Star size={12} /> {show.ratingKinopoisk}
                    </span>
                  )}

                  {show.remaining > 0 && (
                    <span>осталось {show.remaining} сер.</span>
                  )}
                </div>
              </div>

              <button
                className="my-series-start-btn"
                onClick={() => handleStartWatching(show)}
                disabled={updatingId === show.kinopoiskId}
                title="Начать смотреть"
              >
                <Play size={18} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}