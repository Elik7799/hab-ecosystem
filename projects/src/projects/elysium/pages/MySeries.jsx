import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/ElysiumAuthContext'
import { getMovieName, getMoviePath } from '../../../utils/ElysiumMovieName'
import { showSuccess, showError } from '../../../utils/ElysiumToast'
import { useScrollRestore } from '../../../utils/ElysiumScroll'
import { Check, ArrowDownUp, Play, Star, ChevronDown, ChevronUp } from 'lucide-react'

const API_URL_BACKEND = 'https://hab-ecosystem.onrender.com/api'
const PLANNED_PAGE_SIZE = 12

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

const PLANNED_SORT_OPTIONS = [
  { value: 'name_asc', label: 'По названию (А-Я)' },
  { value: 'name_desc', label: 'По названию (Я-А)' },
  { value: 'year_desc', label: 'По году (новые-старые)' },
  { value: 'year_asc', label: 'По году (старые-новые)' },
  { value: 'episodes_desc', label: 'По кол-ву серий (больше-меньше)' },
  { value: 'episodes_asc', label: 'По кол-ву серий (меньше-больше)' },
]

const SS = {
  SCROLL: 'my-series-scroll-y',
  WATCHING_CACHE: 'my-series-watching-cache',
  PLANNED_CACHE: 'my-series-planned-cache',
  PLANNED_OPEN: 'my-series-planned-open',
  PLANNED_PAGE: 'my-series-planned-page',
}

function readCache(key) {
  try {
    const raw = sessionStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return { data: parsed.data, ts: parsed.ts }
  } catch { return null }
}

function writeCache(key, data) {
  try {
    sessionStorage.setItem(key, JSON.stringify({ data, ts: Date.now() }))
  } catch { }
}

export default function ElysiumMySeries() {
  const { token } = useAuth()

  const [series, setSeries] = useState(() => readCache(SS.WATCHING_CACHE)?.data ?? [])
  const [loadingWatching, setLoadingWatching] = useState(
    () => readCache(SS.WATCHING_CACHE)?.data == null
  )
  const [updatingId, setUpdatingId] = useState(null)
  const [sortBy, setSortBy] = useState(() => localStorage.getItem('my-series-sort') || 'name_asc')

  const [plannedOpen, setPlannedOpen] = useState(() => sessionStorage.getItem(SS.PLANNED_OPEN) === 'true')
  const [plannedSeries, setPlannedSeries] = useState(() => readCache(SS.PLANNED_CACHE)?.data ?? [])
  const [loadingPlanned, setLoadingPlanned] = useState(false)
  const [plannedFetchedOnce, setPlannedFetchedOnce] = useState(
    () => readCache(SS.PLANNED_CACHE)?.data != null
  )
  const [plannedSortBy, setPlannedSortBy] = useState(() => localStorage.getItem('my-planned-series-sort') || 'name_asc')
  const [plannedPage, setPlannedPage] = useState(() => {
    const p = parseInt(sessionStorage.getItem(SS.PLANNED_PAGE) || '1')
    return Number.isFinite(p) && p >= 1 ? p : 1
  })

  // Готовы восстанавливать скролл, когда загружен верхний список
  // и (если нижний блок раскрыт) загрузился и он.
  const scrollReady = !loadingWatching && (!plannedOpen || plannedFetchedOnce)
  useScrollRestore(SS.SCROLL, scrollReady)

  useEffect(() => { localStorage.setItem('my-series-sort', sortBy) }, [sortBy])
  useEffect(() => { localStorage.setItem('my-planned-series-sort', plannedSortBy) }, [plannedSortBy])
  useEffect(() => { sessionStorage.setItem(SS.PLANNED_OPEN, String(plannedOpen)) }, [plannedOpen])
  useEffect(() => { sessionStorage.setItem(SS.PLANNED_PAGE, String(plannedPage)) }, [plannedPage])

  const fetchSeries = async () => {
    if (!token) return
    if (series.length === 0) setLoadingWatching(true)
    try {
      const r = await fetch(`${API_URL_BACKEND}/users/me/watching`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (r.ok) {
        const d = await r.json()
        const arr = d.series || []
        setSeries(arr)
        writeCache(SS.WATCHING_CACHE, arr)
      } else {
        showError('Ошибка загрузки')
      }
    } catch {
      showError('Ошибка загрузки')
    } finally {
      setLoadingWatching(false)
    }
  }

  const fetchPlanned = async () => {
    if (!token) return
    setLoadingPlanned(true)
    try {
      const r = await fetch(`${API_URL_BACKEND}/users/me/watchlist-series`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (r.ok) {
        const d = await r.json()
        const arr = d.series || []
        setPlannedSeries(arr)
        writeCache(SS.PLANNED_CACHE, arr)
        setPlannedFetchedOnce(true)
      }
    } catch { } finally {
      setLoadingPlanned(false)
    }
  }

  useEffect(() => {
    if (!token) return
    fetchSeries()
  }, [token])

  useEffect(() => {
    if (!token) return
    if (plannedOpen && !plannedFetchedOnce && !loadingPlanned) {
      fetchPlanned()
    }
  }, [token, plannedOpen, plannedFetchedOnce])

  const togglePlanned = () => {
    const next = !plannedOpen
    setPlannedOpen(next)
    if (next && !plannedFetchedOnce) fetchPlanned()
  }

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
      case 'last_watched_desc': {
        const aT = a.lastWatchedAt ? new Date(a.lastWatchedAt).getTime() : 0
        const bT = b.lastWatchedAt ? new Date(b.lastWatchedAt).getTime() : 0
        return bT - aT
      }
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

  const plannedTotalPages = Math.max(1, Math.ceil(sortedPlanned.length / PLANNED_PAGE_SIZE))
  const plannedPageClamped = Math.min(plannedPage, plannedTotalPages)
  const plannedPageItems = sortedPlanned.slice(
    (plannedPageClamped - 1) * PLANNED_PAGE_SIZE,
    plannedPageClamped * PLANNED_PAGE_SIZE
  )

  useEffect(() => {
    if (plannedPage !== plannedPageClamped) setPlannedPage(plannedPageClamped)
  }, [plannedPage, plannedPageClamped])

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

      {loadingWatching && series.length === 0 ? (
        <p className="my-series-empty">Загрузка...</p>
      ) : series.length === 0 ? (
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

      <div
        className="my-series-header-row my-series-header-row-planned my-series-collapse-header"
        onClick={togglePlanned}
        style={{ cursor: 'pointer', userSelect: 'none' }}
      >
        <div>
          <h2 className="my-series-title">
            Буду смотреть
            {plannedFetchedOnce && (
              <span className="my-series-collapse-count"> ({plannedSeries.length})</span>
            )}
          </h2>
          <p className="my-series-subtitle">Отложенные сериалы</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {plannedOpen && (
            <div className="my-series-sort" onClick={e => e.stopPropagation()}>
              <ArrowDownUp size={16} />
              <select value={plannedSortBy} onChange={e => setPlannedSortBy(e.target.value)} className="my-series-sort-select">
                {PLANNED_SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          )}
          <span style={{ display: 'inline-flex', alignItems: 'center' }}>
            {plannedOpen ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
          </span>
        </div>
      </div>

      {plannedOpen && (
        <>
          {loadingPlanned && !plannedFetchedOnce ? (
            <p className="my-series-empty">Загрузка...</p>
          ) : plannedSeries.length === 0 ? (
            <p className="my-series-empty">Нет сериалов в статусе «Буду смотреть».</p>
          ) : (
            <>
              <div className="my-series-list">
                {plannedPageItems.map(show => (
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

              {plannedTotalPages > 1 && (
                <div className="my-series-pagination">
                  <button
                    type="button"
                    className="my-series-page-btn"
                    onClick={() => setPlannedPage(p => Math.max(1, p - 1))}
                    disabled={plannedPageClamped === 1}
                  >
                    ← Назад
                  </button>
                  <span className="my-series-page-info">
                    Страница {plannedPageClamped} из {plannedTotalPages}
                  </span>
                  <button
                    type="button"
                    className="my-series-page-btn"
                    onClick={() => setPlannedPage(p => Math.min(plannedTotalPages, p + 1))}
                    disabled={plannedPageClamped === plannedTotalPages}
                  >
                    Вперёд →
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}