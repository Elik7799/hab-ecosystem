import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/ElysiumAuthContext'
import { getMovieName } from '../../../utils/ElysiumMovieName'
import { showSuccess, showError } from '../../../utils/ElysiumToast'
import { Check, Tv } from 'lucide-react'

const API_URL_BACKEND = 'https://hab-ecosystem.onrender.com/api'

export default function ElysiumMySeries() {
  const { token } = useAuth()
  const [series, setSeries] = useState([])
  const [loading, setLoading] = useState(true)
  const [updatingId, setUpdatingId] = useState(null)

  useEffect(() => {
    if (!token) return

    const fetchSeries = async () => {
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
      } finally {
        setLoading(false)
      }
    }

    fetchSeries()
  }, [token])

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
        showSuccess(`Серия ${season}x${episode} отмечена как просмотренная!`)
        
        // Обновляем локально, чтобы не перезагружать страницу
        setSeries((prev) =>
          prev.map((s) => {
            if (s.kinopoiskId !== show.kinopoiskId) return s

            const newWatchedCount = s.watchedCount + 1
            const newRemaining = s.remaining - 1

            // Если это была последняя серия — сериал исчезает из списка (статус станет watched)
            if (newRemaining <= 0) {
              setTimeout(() => {
                setSeries((current) => current.filter((item) => item.kinopoiskId !== show.kinopoiskId))
              }, 1000)
              return { ...s, watchedCount: newWatchedCount, remaining: 0, nextEpisode: null }
            }

            return { ...s, watchedCount: newWatchedCount, remaining: newRemaining }
          })
        )
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
      <h1 className="my-series-title">Мои сериалы</h1>
      <p className="my-series-subtitle">
        Сериалы, которые вы сейчас смотрите
      </p>

      {series.length === 0 ? (
        <p className="my-series-empty">
          У вас пока нет сериалов в статусе «Смотрю».{' '}
          <Link to="/elysium" className="my-series-link">
            Найти сериал
          </Link>
        </p>
      ) : (
        <div className="my-series-list">
          {series.map((show) => (
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

                {show.nextEpisode ? (
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
    </div>
  )
}