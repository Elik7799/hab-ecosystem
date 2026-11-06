import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/ElysiumAuthContext'
import { getMovieName, getMoviePath } from '../../../utils/ElysiumMovieName'
import { showSuccess, showError } from '../../../utils/ElysiumToast'
import { Check, ArrowDownUp, Play, Star } from 'lucide-react'

const API_URL_BACKEND = 'https://hab-ecosystem.onrender.com/api'

const SORT_OPTIONS = [
  { value: 'name_asc', label: 'По названию (А-Я)' },
  { value: 'name_desc', label: 'По названию (Я-А)' },
  { value: 'year_desc', label: 'По году (новые-старые)' },
  { value: 'year_asc', label: 'По году (старые-новые)' },
  { value: 'ep_date_desc', label: 'По дате серии (новые-старые)' },
  { value: 'ep_date_asc', label: 'По дате серии (старые-новые)' },
  { value: 'remaining_asc', label: 'По остатку (меньше-больше)' },
  { value: 'remaining_desc', label: 'По остатку (больше-меньше)' },
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
  const [series, setSeries] = useState([])
  const [loading, setLoading] = useState(true)
  const [updatingId, setUpdatingId] = useState(null)
  const [sortBy, setSortBy] = useState(() => localStorage.getItem('my-series-sort') || 'name_asc')
  const [plannedSeries, setPlannedSeries] = useState([])
  const [plannedSortBy, setPlannedSortBy] = useState(() => localStorage.getItem('my-planned-series-sort') || 'name_asc')

  const fetchSeries = async () => {
    if (!token) return
    try {
      const r = await fetch(`${API_URL_BACKEND}/users/me/watching`, { headers: { Authorization: `Bearer ${token}` } })
      if (r.ok) { const d = await r.json(); setSeries(d.series || []) }
    } catch { showError('Ошибка загрузки') }
  }
  const fetchPlanned = async () => {
    if (!token) return
    try {
      const r = await fetch(`${API_URL_BACKEND}/users/me/watchlist-series`, { headers: { Authorization: `Bearer ${token}` } })
      if (r.ok) { const d = await r.json(); setPlannedSeries(d.series || []) }
    } catch {}
  }
  const loadAll = async () => {
    setLoading(true)
    await Promise.all([fetchSeries(), fetchPlanned()])
    setLoading(false)
  }

  useEffect(() => { loadAll() }, [token])
  useEffect(() => { localStorage.setItem('my-series-sort', sortBy) }, [sortBy])
  useEffect(() => { localStorage.setItem('my-planned-series-sort', plannedSortBy) }, [plannedSortBy])

  const handleMarkWatched = async (show, season, episode) => {
    setUpdatingId(show.kinopoiskId)
    try {
      const r = await fetch(`${API_URL_BACKEND}/episodes/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          movieId: show.kinopoiskId,
          seasonNumber: season, episodeNumber: episode,
          watched: true,
        }),
      })
      if (r.ok) { showSuccess(`Серия ${season}x${episode} отмечена`); await fetchSeries() }
      else showError('Не удалось')
    } catch { showError('Ошибка') }
    finally { setUpdatingId(null) }
  }

  const handleStartWatching = async (show) => {
    setUpdatingId(show.kinopoiskId)
    try {
      const r = await fetch(
        `${API_URL_BACKEND}/movies/tv/${show.kinopoiskId}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ status: 'watching' }),
        }
      )
      if (r.ok) {
        showSuccess(`«${getMovieName(show)}» добавлен`)
        await Promise.all([fetchSeries(), fetchPlanned()])
      } else showError('Ошибка')
    } catch { showError('Ошибка') }
    finally { setUpdatingId(null) }
  }

  const sortedSeries = [...series].sort((a, b) => {
    switch (sortBy) {
      case 'name_asc': return getMovieName(a).localeCompare(getMovieName(b), 'ru')
      case 'name_desc': return getMovieName(b).localeCompare(getMovieName(a), 'ru')
      case 'year_desc': return (b.year || 0) - (a.year || 0) || getMovieName(a).localeCompare(getMovieName(b), 'ru')
      case 'year_asc': return (a.year || 0) - (b.year || 0) || getMovieName(a).localeCompare(getMovieName(b), 'ru')
      case 'ep_date_desc': return (b.nextEpisodeDate ? new Date(b.nextEpisodeDate).getTime() : 0) - (a.nextEpisodeDate ? new Date(a.nextEpisodeDate).getTime() : 0)
      case 'ep_date_asc': return (a.nextEpisodeDate ? new Date(a.nextEpisodeDate).getTime() : Infinity) - (b.nextEpisodeDate ? new Date(b.nextEpisodeDate).getTime() : Infinity)
      case 'remaining_asc': return (a.remaining || 0) - (b.remaining || 0)
      case 'remaining_desc': return (b.remaining || 0) - (a.remaining || 0)
      default: return 0
    }
  })

  const sortedPlanned = [...plannedSeries].sort((a, b) => {
    switch (plannedSortBy) {
      case 'name_asc': return getMovieName(a).localeCompare(getMovieName(b), 'ru')
      case 'name_desc': return getMovieName(b).localeCompare(getMovieName(a), 'ru')
      case 'year_desc': return (b.year || 0) - (a.year || 0) || getMovieName(a).localeCompare(getMovieName(b), 'ru')
      case 'year_asc': return (a.year || 0) - (b.year || 0) || getMovieName(a).localeCompare(getMovieName(b), 'ru')
      case 'episodes_desc': return (b.remaining || 0) - (a.remaining || 0)
      case 'episodes_asc': return (a.remaining || 0) - (b.remaining || 0)
      default: return 0
    }
  })

  if (loading) return (
    <div className="my-series-body">
      <h1 className="my-series-title">Мои сериалы</h1>
      <p className="my-series-empty">Загрузка...</p>
    </div>
  )

  return (
    <div className="my-series-body">
      <div className="my-series-header-row">
        <div>
          <h1 className="my-series-title">Смотрю сейчас</h1>
          <p className="my-series-subtitle">Сериалы, которые вы смотрите</p>
        </div>
        <div className="my-series-sort">
          <ArrowDownUp size={16} />
          <select value={sortBy} onChange={e => setSortBy(e.target.value)} className="my-series-sort-select">
            {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>

      {series.length === 0 ? (
        <p className="my-series-empty">Нет сериалов в статусе «Смотрю».</p>
      ) : (
        <div className="my-series-list">
          {sortedSeries.map(show => (
            <div key={show.kinopoiskId} className="my-series-card">
              <Link to={getMoviePath(show)}>
                <img
                  src={show.posterUrlPreview || 'https://kinopoiskapiunofficial.tech/images/posters/kp/no-poster.png'}
                  alt={getMovieName(show)}
                  className="my-series-poster"
                  onError={e => { e.target.src = 'https://kinopoiskapiunofficial.tech/images/posters/kp/no-poster.png' }}
                />
              </Link>
              <div className="my-series-info">
                <Link to={getMoviePath(show)} className="my-series-name">{getMovieName(show)}</Link>
                {show.totalAired === 0 ? (
                  <p className="my-series-done" style={{ color: '#888' }}>Серии ещё не вышли</p>
                ) : show.nextEpisode ? (
                  <div className="my-series-next">
                    <p className="my-series-next-label">Следующая серия:</p>
                    <p className="my-series-next-title">
                      {show.nextEpisodeName || `Сезон ${show.nextSeason}, Серия ${show.nextEpisode}`}
                    </p>
                    <p className="my-series-next-meta">Сезон {show.nextSeason} · Серия {show.nextEpisode}</p>
                    <button
                      className="my-series-btn"
                      onClick={() => handleMarkWatched(show, show.nextSeason, show.nextEpisode)}
                      disabled={updatingId === show.kinopoiskId}
                    >
                      <Check size={16} />
                      {updatingId === show.kinopoiskId ? 'Загрузка...' : 'Отметить'}
                    </button>
                  </div>
                ) : (
                  <p className="my-series-done">Все вышедшие просмотрены!</p>
                )}
              </div>
              <div className="my-series-stats">
                <div className="my-series-stat">
                  <span className="my-series-stat-value">{show.remaining}</span>
                  <span className="my-series-stat-label">осталось</span>
                </div>
                <div className="my-series-progress-bar">
                  <div className="my-series-progress-fill" style={{ width: `${(show.watchedCount / (show.totalAired || 1)) * 100}%` }} />
                </div>
                <span className="my-series-progress-text">{show.watchedCount} из {show.totalAired}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="my-series-header-row my-series-header-row-planned">
        <div>
          <h2 className="my-series-title">Буду смотреть</h2>
          <p className="my-series-subtitle">Отложенные сериалы</p>
        </div>
        <div className="my-series-sort">
          <ArrowDownUp size={16} />
          <select value={plannedSortBy} onChange={e => setPlannedSortBy(e.target.value)} className="my-series-sort-select">
            {PLANNED_SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>

      {plannedSeries.length === 0 ? (
        <p className="my-series-empty">Нет сериалов в статусе «Буду смотреть».</p>
      ) : (
        <div className="my-series-list">
          {sortedPlanned.map(show => (
            <div key={show.kinopoiskId} className="my-series-card my-series-card-planned">
              <Link to={getMoviePath(show)}>
                <img
                  src={show.posterUrlPreview || 'https://kinopoiskapiunofficial.tech/images/posters/kp/no-poster.png'}
                  alt={getMovieName(show)}
                  className="my-series-poster"
                  onError={e => { e.target.src = 'https://kinopoiskapiunofficial.tech/images/posters/kp/no-poster.png' }}
                />
              </Link>
              <div className="my-series-info">
                <Link to={getMoviePath(show)} className="my-series-name">{getMovieName(show)}</Link>
                {show.nameOriginal && <p className="my-series-original">{show.nameOriginal}</p>}
                <div className="my-series-meta-row">
                  {show.year ? <span>{show.year}</span> : null}
                  {show.ratingKinopoisk ? <span className="my-series-rating"><Star size={12} /> {show.ratingKinopoisk}</span> : null}
                  {show.remaining > 0 && <span>осталось {show.remaining} сер.</span>}
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