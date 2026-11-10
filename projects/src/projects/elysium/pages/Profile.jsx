import { useState, useEffect, useLayoutEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useAuth } from '../context/ElysiumAuthContext'
import { getMovieName, getMoviePath } from '../../../utils/ElysiumMovieName'
import { ProfileSkeleton } from '../components/ElysiumSkeleton'
import { showSuccess, showError } from '../../../utils/ElysiumToast'
import { ChevronLeft, ChevronRight } from 'lucide-react'

const API_URL_BACKEND = 'https://hab-ecosystem.onrender.com/api'
const PAGE_SIZE = 20

const STATUS_FILTERS = [
  { value: 'all', label: 'Все' },
  { value: 'watching', label: 'Смотрю' },
  { value: 'watched', label: 'Посмотрел' },
  { value: 'want_to_watch', label: 'Буду смотреть' },
  { value: 'dropped', label: 'Перестал смотреть' },
]

const STATUS_LABELS = {
  watching: 'Смотрю',
  watched: 'Посмотрел',
  want_to_watch: 'Буду смотреть',
  dropped: 'Перестал смотреть',
}

const pageKey   = (pid) => `profile-page-${pid}`
const scrollKey = (pid) => `profile-scroll-${pid}`

export default function ElysiumProfile() {
  const { id } = useParams()
  const { token, user: currentUser } = useAuth()

  const [profile, setProfile] = useState(null)
  const [stats, setStats] = useState(null)
  const [isFriend, setIsFriend] = useState(false)
  const [friendshipStatus, setFriendshipStatus] = useState('none')
  const [friendshipId, setFriendshipId] = useState(null)
  const [isOwn, setIsOwn] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [actionLoading, setActionLoading] = useState(false)

  const [movies, setMovies] = useState([])
  const [filter, setFilter] = useState('all')
  const [moviesLoading, setMoviesLoading] = useState(false)
  const [commonMovies, setCommonMovies] = useState([])
  const [showCommon, setShowCommon] = useState(false)

  const profileId = id || currentUser?.id

  // ── Пагинация ──
  const [page, setPage] = useState(() => {
    if (!profileId) return 1
    const p = Number(sessionStorage.getItem(pageKey(profileId)))
    return Number.isFinite(p) && p >= 1 ? p : 1
  })

  // ── Все вычисления — до хуков, которые от них зависят ──
  const totalPages  = Math.max(1, Math.ceil(movies.length / PAGE_SIZE))
  const pageClamped = Math.min(Math.max(1, page), totalPages)
  const pageItems   = movies.slice((pageClamped - 1) * PAGE_SIZE, pageClamped * PAGE_SIZE)

  // ───────────────────── ХУКИ ─────────────────────
  // 1) Сохраняем страницу
  useEffect(() => {
    if (!profileId) return
    sessionStorage.setItem(pageKey(profileId), String(page))
  }, [page, profileId])

  // 2) Сохраняем скролл при размонтировании
  useEffect(() => {
    if (!profileId) return
    return () => {
      sessionStorage.setItem(scrollKey(profileId), String(window.scrollY))
    }
  }, [profileId])

  // 3) Восстанавливаем скролл после загрузки
  useLayoutEffect(() => {
    if (!profileId || loading || moviesLoading) return
    const y = Number(sessionStorage.getItem(scrollKey(profileId)))
    if (!y) return
    const raf = requestAnimationFrame(() => window.scrollTo(0, y))
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, moviesLoading])

  // 4) Загрузка профиля
  useEffect(() => {
    if (!token || !profileId) return
    (async () => {
      setLoading(true); setError('')
      try {
        const r = await fetch(`${API_URL_BACKEND}/users/${profileId}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        const d = await r.json()
        if (!r.ok) { setError(d.error || 'Не найден'); return }
        setProfile(d.user); setStats(d.stats)
        setIsFriend(d.isFriend); setFriendshipStatus(d.friendshipStatus || 'none')
        setFriendshipId(d.friendshipId || null); setIsOwn(d.isOwn)
      } catch {
        setError('Не удалось загрузить профиль'); showError('Ошибка')
      } finally { setLoading(false) }
    })()
  }, [token, profileId])

  // 5) Загрузка фильмов
  useEffect(() => {
    if (!token || !profileId) return
    (async () => {
      setMoviesLoading(true)
      try {
        const url = `${API_URL_BACKEND}/users/${profileId}/movies${filter !== 'all' ? `?status=${filter}` : ''}`
        const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
        const d = await r.json()
        setMovies(d.movies || [])
      } catch {} finally { setMoviesLoading(false) }
    })()
  }, [token, profileId, filter])

  // 6) Клампим страницу, если после смены фильтра или удаления список стал короче
  useEffect(() => {
    if (page !== pageClamped) setPage(pageClamped)
  }, [page, pageClamped])

  // ───────────────────── ОБРАБОТЧИКИ ─────────────────────
  const handleFilterChange = (value) => {
    setFilter(value)
    setPage(1)
    window.scrollTo(0, 0)
    if (profileId) sessionStorage.setItem(scrollKey(profileId), '0')
  }

  const handlePageChange = (next) => {
    setPage(next)
    window.scrollTo(0, 0)
    if (profileId) sessionStorage.setItem(scrollKey(profileId), '0')
  }

  const handleShowCommon = async () => {
    if (!isFriend) return
    try {
      const r = await fetch(`${API_URL_BACKEND}/users/${profileId}/common`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const d = await r.json()
      setCommonMovies(d.movies || []); setShowCommon(true)
    } catch { showError('Ошибка') }
  }

  const handleAddFriend = async () => {
    setActionLoading(true)
    try {
      const r = await fetch(`${API_URL_BACKEND}/friends`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ friendId: parseInt(profileId) }),
      })
      const d = await r.json()
      if (!r.ok) { showError(d.error || 'Ошибка'); return }
      setFriendshipStatus('pending_outgoing'); setFriendshipId(d.id)
      showSuccess('Заявка отправлена!')
    } catch { showError('Ошибка') } finally { setActionLoading(false) }
  }

  const handleRemoveFriend = async () => {
    if (!friendshipId) return
    if (!confirm('Удалить из друзей?')) return
    setActionLoading(true)
    try {
      const r = await fetch(`${API_URL_BACKEND}/friends/${friendshipId}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      })
      if (!r.ok) { showError('Ошибка'); return }
      setIsFriend(false); setFriendshipStatus('none'); setFriendshipId(null)
      showSuccess('Удалено')
    } catch { showError('Ошибка') } finally { setActionLoading(false) }
  }

  const handleAcceptFriend = async () => {
    if (!friendshipId) return
    setActionLoading(true)
    try {
      const r = await fetch(`${API_URL_BACKEND}/friends/${friendshipId}`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${token}` },
      })
      if (!r.ok) { showError('Ошибка'); return }
      setIsFriend(true); setFriendshipStatus('accepted')
      showSuccess('Заявка принята')
    } catch { showError('Ошибка') } finally { setActionLoading(false) }
  }

  // ───────────────────── РАННИЕ RETURN (только после всех хуков) ─────────────────────
  if (loading) return <ProfileSkeleton />

  if (error || !profile) {
    return (
      <div className="profile-body">
        <p className="profile-error">{error || 'Не найден'}</p>
        <Link to="/elysium" className="profile-back">← На главную</Link>
      </div>
    )
  }

  const joinDate = new Date(profile.created_at).toLocaleDateString('ru-RU', {
    year: 'numeric', month: 'long',
  })

  return (
    <div className="profile-body">
      <div className="profile-header">
        <div className="profile-avatar">{profile.name.charAt(0).toUpperCase()}</div>
        <div className="profile-info">
          <h1 className="profile-name">@{profile.name}</h1>
          {isOwn && <p className="profile-email">{profile.email}</p>}
          <p className="profile-date">С нами с {joinDate}</p>
          {isFriend && <span className="profile-badge">У вас в друзьях</span>}
        </div>
        {!isOwn && (
          <div className="profile-actions">
            {friendshipStatus === 'none' && (
              <button type="button" className="profile-action profile-action-primary" onClick={handleAddFriend} disabled={actionLoading}>
                {actionLoading ? '...' : 'Добавить в друзья'}
              </button>
            )}
            {friendshipStatus === 'pending_outgoing' && (
              <button type="button" className="profile-action profile-action-secondary" onClick={handleRemoveFriend} disabled={actionLoading}>
                {actionLoading ? '...' : 'Отменить заявку'}
              </button>
            )}
            {friendshipStatus === 'pending_incoming' && (
              <button type="button" className="profile-action profile-action-primary" onClick={handleAcceptFriend} disabled={actionLoading}>
                {actionLoading ? '...' : 'Принять заявку'}
              </button>
            )}
            {friendshipStatus === 'accepted' && (
              <button type="button" className="profile-action profile-action-danger" onClick={handleRemoveFriend} disabled={actionLoading}>
                {actionLoading ? '...' : 'Удалить из друзей'}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="profile-stats">
        <div className="profile-stat">
          <span className="profile-stat-value">{stats.watched}</span>
          <span className="profile-stat-label">Посмотрел</span>
        </div>
        <div className="profile-stat">
          <span className="profile-stat-value">{stats.want_to_watch}</span>
          <span className="profile-stat-label">Буду смотреть</span>
        </div>
        <div className="profile-stat">
          <span className="profile-stat-value">{stats.friends}</span>
          <span className="profile-stat-label">Друзей</span>
        </div>
      </div>

      {!isOwn && isFriend && (
        <div className="profile-common-btn">
          <button type="button" className="profile-btn" onClick={handleShowCommon}>
            Показать общие фильмы
          </button>
        </div>
      )}

      {showCommon && (
        <div className="profile-common">
          <h2 className="profile-heading">
            Общие фильмы <span className="profile-count">{commonMovies.length}</span>
          </h2>
          {commonMovies.length === 0 ? (
            <p className="profile-empty">Нет общих фильмов</p>
          ) : (
            <div className="profile-moviesgrid">
              {commonMovies.map(m => (
                <Link key={`${m.kinopoiskId}:${m.type}`} to={getMoviePath(m)} className="profile-moviecard">
                  <img src={m.posterUrlPreview} alt={getMovieName(m)} className="profile-movieposter" />
                  <div className="profile-movieinfo">
                    <p className="profile-moviename">{getMovieName(m)}</p>
                    <p className="profile-movieyear">{m.year && m.year !== 0 ? m.year : '—'}</p>
                  </div>
                </Link>
              ))}
            </div>
          )}
          <button type="button" className="profile-btn profile-btn-secondary" onClick={() => setShowCommon(false)}>Скрыть</button>
        </div>
      )}

      <div className="profile-movies">
        <h2 className="profile-heading">
          {isOwn ? 'Мои фильмы' : `Фильмы @${profile.name}`}
          <span className="profile-count">{movies.length}</span>
        </h2>
        <div className="profile-filters">
          {STATUS_FILTERS.map(f => (
            <button
              key={f.value}
              className={filter === f.value ? 'profile-filterbtn active' : 'profile-filterbtn'}
              onClick={() => handleFilterChange(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
        {moviesLoading ? (
          <p className="profile-empty">Загрузка...</p>
        ) : movies.length === 0 ? (
          <p className="profile-empty">
            {isOwn ? 'Нет фильмов' : 'У пользователя нет фильмов'}
          </p>
        ) : (
          <>
            <div className="profile-moviesgrid">
              {pageItems.map(m => (
                <Link
                  key={`${m.kinopoiskId}:${m.type}`}
                  to={getMoviePath(m)}
                  className={`profile-moviecard status-${m.my_status || 'not_watched'}`}
                >
                  <img src={m.posterUrlPreview} alt={getMovieName(m)} className="profile-movieposter" />
                  <div className="profile-movieinfo">
                    <p className="profile-moviename">{getMovieName(m)}</p>
                    <p className="profile-movieyear">{m.year && m.year !== 0 ? m.year : '—'}</p>
                    {isOwn && <span className="profile-moviestatus">{STATUS_LABELS[m.status]}</span>}
                  </div>
                </Link>
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
                  <ChevronLeft size={16} /> Назад
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
                  Вперёд <ChevronRight size={16} />
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}