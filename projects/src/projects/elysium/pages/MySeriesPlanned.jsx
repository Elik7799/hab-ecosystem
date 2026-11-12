import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/ElysiumAuthContext'
import { getMovieName, getMoviePath } from '../../../utils/ElysiumMovieName'
import { showSuccess, showError } from '../../../utils/ElysiumToast'
import { useScrollRestore, scrollToTop } from '../../../utils/ElysiumScroll'
import { ArrowDownUp, Play, Star } from 'lucide-react'

const API_URL_BACKEND = 'https://hab-ecosystem.onrender.com/api'
const PAGE_SIZE = 12

const SORT_OPTIONS = [
  { value: 'name_asc', label: 'По названию (А-Я)' },
  { value: 'name_desc', label: 'По названию (Я-А)' },
  { value: 'year_desc', label: 'По году (новые-старые)' },
  { value: 'year_asc', label: 'По году (старые-новые)' },
  { value: 'episodes_desc', label: 'По кол-ву серий (больше-меньше)' },
  { value: 'episodes_asc', label: 'По кол-ву серий (меньше-больше)' },
]

const SS = {
  SCROLL: 'planned-series-scroll-y',
  CACHE: 'planned-series-cache',
  PAGE: 'planned-series-page',
  SORT: 'planned-series-sort',
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

export default function ElysiumMySeriesPlanned() {
  const { token } = useAuth()

  const [series, setSeries] = useState(() => readCache() ?? [])
  const [loading, setLoading] = useState(() => readCache() == null)
  const [updatingId, setUpdatingId] = useState(null)
  const [sortBy, setSortBy] = useState(() => localStorage.getItem(SS.SORT) || 'name_asc')
  const [page, setPage] = useState(() => {
    const p = parseInt(sessionStorage.getItem(SS.PAGE) || '1')
    return Number.isFinite(p) && p >= 1 ? p : 1
  })

  useScrollRestore(SS.SCROLL, !loading)

  useEffect(() => { localStorage.setItem(SS.SORT, sortBy) }, [sortBy])
  useEffect(() => { sessionStorage.setItem(SS.PAGE, String(page)) }, [page])

  const fetchSeries = async () => {
    if (!token) return
    if (series.length === 0) setLoading(true)
    try {
      const r = await fetch(`${API_URL_BACKEND}/users/me/watchlist-series`, {
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
        showSuccess(`«${getMovieName(show)}» добавлен в «Смотрю»`)
        setSeries(prev => {
          const next = prev.filter(s => s.kinopoiskId !== show.kinopoiskId)
          writeCache(next)
          return next
        })
      } else showError('Ошибка')
    } catch { showError('Ошибка') }
    finally { setUpdatingId(null) }
  }

  const sorted = [...series].sort((a, b) => {
    switch (sortBy) {
      case 'name_asc': return getMovieName(a).localeCompare(getMovieName(b), 'ru')
      case 'name_desc': return getMovieName(b).localeCompare(getMovieName(a), 'ru')
      case 'year_desc': return (b.year || 0) - (a.year || 0) || getMovieName(a).localeCompare(getMovieName(b), 'ru')
      case 'year_asc': return (a.year || 0) - (b.year || 0) || getMovieName(a).localeCompare(getMovieName(b), 'ru')
      case 'episodes_desc': return (b.remaining || 0) - (a.remaining || 0)
      case 'episodes_asc': return (a.remaining || 0) - (b.remaining || 0)
      default: return 0
    }
  })

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE))
  const pageClamped = Math.min(page, totalPages)
  const pageItems = sorted.slice((pageClamped - 1) * PAGE_SIZE, pageClamped * PAGE_SIZE)

  useEffect(() => {
    if (loading) return
    if (page !== pageClamped) setPage(pageClamped)
  }, [page, pageClamped, loading])

  const handlePageChange = (next) => {
    setPage(next)
    scrollToTop()
    sessionStorage.setItem(SS.SCROLL, '0')
  }

  return (
    <div className="my-series-body">
      <div style={{ textAlign: 'center', margin: '0 0 20px' }}>
        <Link
          to="/elysium/my-series"
          className="my-series-btn"
          style={{ textDecoration: 'none', display: 'inline-flex' }}
        >
          ← Смотрю сейчас
        </Link>
      </div>

      <div className="my-series-header-row">
        <div>
          <h1 className="my-series-title">Буду смотреть</h1>
          <p className="my-series-subtitle">Отложенные сериалы</p>
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
        <p className="my-series-empty">Нет сериалов в статусе «Буду смотреть».</p>
      ) : (
        <>
          <div className="my-series-list">
            {pageItems.map(show => (
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

          {totalPages > 1 && (
            <div className="my-series-pagination">
              <button
                type="button"
                className="my-series-page-btn"
                onClick={() => handlePageChange(Math.max(1, pageClamped - 1))}
                disabled={pageClamped === 1}
              >
                ← Назад
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
                Вперёд →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}