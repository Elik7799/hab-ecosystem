import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/ElysiumAuthContext'
import { getMovieName, getMoviePath } from '../../../utils/ElysiumMovieName'
import { showSuccess, showError } from '../../../utils/ElysiumToast'
import { useScrollRestore } from '../../../utils/ElysiumScroll'
import { Check, ArrowDownUp } from 'lucide-react'

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
  { value: 'last_watched_desc', label: 'Последнее отмеченное' },
]

const SS = {
  SCROLL: 'my-series-scroll-y',
  CACHE: 'my-series-watching-cache',
}

function readCache() {
  try {
    const raw = sessionStorage.getItem(SS.CACHE)
    if (!raw) return null
    return JSON.parse(raw).data ?? null
  } catch { return null }
}

function writeCache(data) {
  try {
    sessionStorage.setItem(SS.CACHE, JSON.stringify({ data, ts: Date.now() }))
  } catch { }
}

export default function ElysiumMySeries() {
  const { token } = useAuth()

  const [series, setSeries] = useState(() => readCache() ?? [])
  const [loading, setLoading] = useState(() => readCache() == null)
  const [updatingId, setUpdatingId] = useState(null)
  const [sortBy, setSortBy] = useState(() => localStorage.getItem('my-series-sort') || 'name_asc')

  useScrollRestore(SS.SCROLL, !loading)

  useEffect(() => { localStorage.setItem('my-series-sort', sortBy) }, [sortBy])

  const fetchSeries = async () => {
    if (!token) return
    if (series.length === 0) setLoading(true)
    try {
      const r = await fetch(`${API_URL_BACKEND}/users/me/watching`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (r.ok) {
        const d = await r.json()
        const arr = d.series || []
        setSeries(arr)
        writeCache(arr)
      } else {
        showError('Ошибка загрузки')
      }
    } catch {
      showError('Ошибка загрузки')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!token) return
    fetchSeries()
  }, [token])

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
      if (r.ok) {
        showSuccess(`Серия ${season}x${episode} отмечена`)
        await fetchSeries()
      } else showError('Не удалось')
    } catch { showError('Ошибка') }
    finally { setUpdatingId(null) }
  }

  const sorted = [...series].sort((a, b) => {
    switch (sortBy) {
      case 'name_asc': return getMovieName(a).localeCompare(getMovieName(b), 'ru')
      case 'name_desc': return getMovieName(b).localeCompare(getMovieName(a), 'ru')
      case 'year_desc': return (b.year || 0) - (a.year || 0) || getMovieName(a).localeCompare(getMovieName(b), 'ru')
      case 'year_asc': return (a.year || 0) - (b.year || 0) || getMovieName(a).localeCompare(getMovieName(b), 'ru')
      case 'ep_date_desc': return (b.nextEpisodeDate ? new Date(b.nextEpisodeDate).getTime() : 0) - (a.nextEpisodeDate ? new Date(a.nextEpisodeDate).getTime() : 0)
      case 'ep_date_asc': return (a.nextEpisodeDate ? new Date(a.nextEpisodeDate).getTime() : Infinity) - (b.nextEpisodeDate ? new Date(b.nextEpisodeDate).getTime() : Infinity)
      case 'remaining_asc': return (a.remaining || 0) - (b.remaining || 0)
      case 'remaining_desc': return (b.remaining || 0) - (a.remaining || 0)
      case 'last_watched_desc': {
        const aT = a.lastWatchedAt ? new Date(a.lastWatchedAt).getTime() : 0
        const bT = b.lastWatchedAt ? new Date(b.lastWatchedAt).getTime() : 0
        return bT - aT
      }
      default: return 0
    }
  })

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

      <div style={{ textAlign: 'center', margin: '0 0 25px' }}>
        <Link
          to="/elysium/planned-series"
          className="my-series-btn"
          style={{ textDecoration: 'none', display: 'inline-flex' }}
        >
          Буду смотреть →
        </Link>
      </div>

      {loading && series.length === 0 ? (
        <p className="my-series-empty">Загрузка...</p>
      ) : series.length === 0 ? (
        <p className="my-series-empty">Нет сериалов в статусе «Смотрю».</p>
      ) : (
        <div className="my-series-list">
          {sorted.map(show => (
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
    </div>
  )
}