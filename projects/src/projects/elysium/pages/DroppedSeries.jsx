import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/ElysiumAuthContext'
import { getMovieName, getMoviePath } from '../../../utils/ElysiumMovieName'
import { showSuccess, showError } from '../../../utils/ElysiumToast'
import { useScrollRestore } from '../../../utils/ElysiumScroll'
import { ArrowDownUp, Play, Star } from 'lucide-react'

const API_URL_BACKEND = 'https://hab-ecosystem.onrender.com/api'

const SORT_OPTIONS = [
  { value: 'last_watched_desc', label: 'Последнее отмеченное' },
  { value: 'name_asc', label: 'По названию (А-Я)' },
  { value: 'name_desc', label: 'По названию (Я-А)' },
  { value: 'year_desc', label: 'По году (новые-старые)' },
  { value: 'year_asc', label: 'По году (старые-новые)' },
  { value: 'remaining_asc', label: 'По остатку (меньше-больше)' },
  { value: 'remaining_desc', label: 'По остатку (больше-меньше)' },
]

const SS = {
  SCROLL: 'dropped-series-scroll-y',
  CACHE: 'dropped-series-cache',
  SORT: 'dropped-series-sort',
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

export default function ElysiumDroppedSeries() {
  const { token } = useAuth()
  const [series, setSeries] = useState(() => readCache() ?? [])
  const [loading, setLoading] = useState(() => readCache() == null)
  const [updatingId, setUpdatingId] = useState(null)
  const [sortBy, setSortBy] = useState(
    () => localStorage.getItem(SS.SORT) || 'last_watched_desc'
  )

  useScrollRestore(SS.SCROLL, !loading)

  useEffect(() => { localStorage.setItem(SS.SORT, sortBy) }, [sortBy])

  const fetchSeries = async () => {
    if (!token) return
    if (series.length === 0) setLoading(true)
    try {
      const r = await fetch(`${API_URL_BACKEND}/users/me/dropped`, {
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

  const handleResume = async (show) => {
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
        showSuccess(`«${getMovieName(show)}» снова в «Смотрю»`)
        setSeries(prev => {
          const next = prev.filter(s => s.kinopoiskId !== show.kinopoiskId)
          writeCache(next)
          return next
        })
      } else {
        showError('Не удалось')
      }
    } catch {
      showError('Ошибка')
    } finally {
      setUpdatingId(null)
    }
  }

  const sorted = [...series].sort((a, b) => {
    switch (sortBy) {
      case 'last_watched_desc': {
        const aT = a.lastWatchedAt ? new Date(a.lastWatchedAt).getTime() : 0
        const bT = b.lastWatchedAt ? new Date(b.lastWatchedAt).getTime() : 0
        return bT - aT
      }
      case 'name_asc': return getMovieName(a).localeCompare(getMovieName(b), 'ru')
      case 'name_desc': return getMovieName(b).localeCompare(getMovieName(a), 'ru')
      case 'year_desc': return (b.year || 0) - (a.year || 0) || getMovieName(a).localeCompare(getMovieName(b), 'ru')
      case 'year_asc': return (a.year || 0) - (b.year || 0) || getMovieName(a).localeCompare(getMovieName(b), 'ru')
      case 'remaining_asc': return (a.remaining || 0) - (b.remaining || 0)
      case 'remaining_desc': return (b.remaining || 0) - (a.remaining || 0)
      default: return 0
    }
  })

  return (
    <div className="my-series-body">
      <div className="my-series-header-row">
        <div>
          <h1 className="my-series-title">Перестал смотреть</h1>
          <p className="my-series-subtitle">
            Сериалы, которые вы бросили. Прогресс сохранён — можно вернуться.
          </p>
        </div>
        <div className="my-series-sort">
          <ArrowDownUp size={16} />
          <select value={sortBy} onChange={e => setSortBy(e.target.value)} className="my-series-sort-select">
            {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>

      {loading && series.length === 0 ? (
        <p className="my-series-empty">Загрузка...</p>
      ) : series.length === 0 ? (
        <p className="my-series-empty">Здесь пусто — вы ещё не бросили ни одного сериала.</p>
      ) : (
        <div className="my-series-list">
          {sorted.map(show => (
            <div key={show.kinopoiskId} className="my-series-card my-series-card-dropped status-dropped">
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
                  {show.ratingKinopoisk ? (
                    <span className="my-series-rating"><Star size={12} /> {show.ratingKinopoisk}</span>
                  ) : null}
                  {show.watchedCount > 0 && (
                    <span>просмотрено {show.watchedCount} из {show.episodesCount}</span>
                  )}
                </div>
              </div>
              <button
                className="my-series-start-btn"
                onClick={() => handleResume(show)}
                disabled={updatingId === show.kinopoiskId}
                title="Снова смотреть"
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