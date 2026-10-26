import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useAuth } from '../context/ElysiumAuthContext'
import { getMovieName } from '../../../utils/ElysiumMovieName'
import { ProfileSkeleton } from '../components/ElysiumSkeleton'
import { showSuccess, showError } from '../../../utils/ElysiumToast'

const API_URL_BACKEND = 'http://localhost:5000/api'

const STATUS_FILTERS = [
  { value: 'all', label: 'Все' },
  { value: 'watched', label: 'Посмотрел' },
  { value: 'want_to_watch', label: 'Буду смотреть' },
]

const STATUS_LABELS = {
  watched: 'Посмотрел',
  want_to_watch: 'Буду смотреть',
}

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

  useEffect(() => {
    if (!token || !profileId) return

    const fetchProfile = async () => {
      setLoading(true)
      setError('')

      try {
        const res = await fetch(`${API_URL_BACKEND}/users/${profileId}`, {
          headers: { Authorization: `Bearer ${token}` },
        })

        const data = await res.json()
        if (!res.ok) {
          setError(data.error || 'Профиль не найден')
          return
        }

        setProfile(data.user)
        setStats(data.stats)
        setIsFriend(data.isFriend)
        setFriendshipStatus(data.friendshipStatus || 'none')
        setFriendshipId(data.friendshipId || null)
        setIsOwn(data.isOwn)
      } catch (err) {
        setError('Не удалось загрузить профиль')
        showError('Ошибка загрузки профиля')
        console.error(err)
      } finally {
        setLoading(false)
      }
    }

    fetchProfile()
  }, [token, profileId])

  useEffect(() => {
    if (!token || !profileId) return

    const fetchMovies = async () => {
      setMoviesLoading(true)
      try {
        const url = `${API_URL_BACKEND}/users/${profileId}/movies${
          filter !== 'all' ? `?status=${filter}` : ''
        }`
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
        })
        const data = await res.json()
        setMovies(data.movies || [])
      } catch (err) {
        console.error(err)
      } finally {
        setMoviesLoading(false)
      }
    }

    fetchMovies()
  }, [token, profileId, filter])

  const handleShowCommon = async () => {
    if (!isFriend) return

    try {
      const res = await fetch(`${API_URL_BACKEND}/users/${profileId}/common`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      setCommonMovies(data.movies || [])
      setShowCommon(true)
    } catch (err) {
      console.error(err)
      showError('Ошибка загрузки общих фильмов')
    }
  }

  const handleAddFriend = async () => {
    setActionLoading(true)
    try {
      const res = await fetch(`${API_URL_BACKEND}/friends`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ friendId: parseInt(profileId) }),
      })

      const data = await res.json()
      if (!res.ok) {
        showError(data.error || 'Ошибка')
        return
      }

      setFriendshipStatus('pending_outgoing')
      setFriendshipId(data.id)
      showSuccess('Заявка отправлена!')
    } catch (err) {
      console.error(err)
      showError('Ошибка отправки заявки')
    } finally {
      setActionLoading(false)
    }
  }

  const handleRemoveFriend = async () => {
    if (!friendshipId) return

    if (!confirm('Удалить из друзей?')) return

    setActionLoading(true)
    try {
      const res = await fetch(`${API_URL_BACKEND}/friends/${friendshipId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })

      if (!res.ok) {
        showError('Ошибка удаления')
        return
      }

      setIsFriend(false)
      setFriendshipStatus('none')
      setFriendshipId(null)
      showSuccess('Удалено из друзей')
    } catch (err) {
      console.error(err)
      showError('Ошибка удаления')
    } finally {
      setActionLoading(false)
    }
  }

  const handleAcceptFriend = async () => {
    if (!friendshipId) return

    setActionLoading(true)
    try {
      const res = await fetch(`${API_URL_BACKEND}/friends/${friendshipId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
      })

      if (!res.ok) {
        showError('Ошибка')
        return
      }

      setIsFriend(true)
      setFriendshipStatus('accepted')
      showSuccess('Заявка принята')
    } catch (err) {
      console.error(err)
      showError('Ошибка принятия')
    } finally {
      setActionLoading(false)
    }
  }

  if (loading) {
    return <ProfileSkeleton />
  }

  if (error || !profile) {
    return (
      <div className="profile-body">
        <p className="profile-error">{error || 'Профиль не найден'}</p>
        <Link to="/elysium" className="profile-back">
          ← На главную
        </Link>
      </div>
    )
  }

  const joinDate = new Date(profile.created_at).toLocaleDateString('ru-RU', {
    year: 'numeric',
    month: 'long',
  })

  return (
    <div className="profile-body">
      <div className="profile-header">
        <div className="profile-avatar">
          {profile.name.charAt(0).toUpperCase()}
        </div>
        <div className="profile-info">
          <h1 className="profile-name">@{profile.name}</h1>
          {isOwn && <p className="profile-email">{profile.email}</p>}
          <p className="profile-date">С нами с {joinDate}</p>
          {isFriend && <span className="profile-badge">У вас в друзьях</span>}
        </div>

        {!isOwn && (
          <div className="profile-actions">
            {friendshipStatus === 'none' && (
              <button
                type="button"
                className="profile-action profile-action-primary"
                onClick={handleAddFriend}
                disabled={actionLoading}
              >
                {actionLoading ? '...' : 'Добавить в друзья'}
              </button>
            )}

            {friendshipStatus === 'pending_outgoing' && (
              <button
                type="button"
                className="profile-action profile-action-secondary"
                onClick={handleRemoveFriend}
                disabled={actionLoading}
              >
                {actionLoading ? '...' : 'Отменить заявку'}
              </button>
            )}

            {friendshipStatus === 'pending_incoming' && (
              <button
                type="button"
                className="profile-action profile-action-primary"
                onClick={handleAcceptFriend}
                disabled={actionLoading}
              >
                {actionLoading ? '...' : 'Принять заявку'}
              </button>
            )}

            {friendshipStatus === 'accepted' && (
              <button
                type="button"
                className="profile-action profile-action-danger"
                onClick={handleRemoveFriend}
                disabled={actionLoading}
              >
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
          <button
            type="button"
            className="profile-btn"
            onClick={handleShowCommon}
          >
            Показать общие фильмы
          </button>
        </div>
      )}

      {showCommon && (
        <div className="profile-common">
          <h2 className="profile-heading">
            Общие фильмы{' '}
            <span className="profile-count">{commonMovies.length}</span>
          </h2>
          {commonMovies.length === 0 ? (
            <p className="profile-empty">У вас пока нет общих фильмов</p>
          ) : (
            <div className="profile-moviesgrid">
              {commonMovies.map((movie) => (
                <Link
                  key={movie.kinopoiskId}
                  to={`/elysium/movie/${movie.kinopoiskId}`}
                  className="profile-moviecard"
                >
                  <img
                    src={movie.posterUrlPreview}
                    alt={getMovieName(movie)}
                    className="profile-movieposter"
                  />
                  <div className="profile-movieinfo">
                    <p className="profile-moviename">{getMovieName(movie)}</p>
                    <p className="profile-movieyear">{movie.year}</p>
                  </div>
                </Link>
              ))}
            </div>
          )}
          <button
            type="button"
            className="profile-btn profile-btn-secondary"
            onClick={() => setShowCommon(false)}
          >
            Скрыть
          </button>
        </div>
      )}

      <div className="profile-movies">
        <h2 className="profile-heading">
          {isOwn ? 'Мои фильмы' : `Фильмы @${profile.name}`}
          <span className="profile-count">{movies.length}</span>
        </h2>

        <div className="profile-filters">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              className={
                filter === f.value
                  ? 'profile-filterbtn active'
                  : 'profile-filterbtn'
              }
              onClick={() => setFilter(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>

        {moviesLoading ? (
          <p className="profile-empty">Загрузка...</p>
        ) : movies.length === 0 ? (
          <p className="profile-empty">
            {isOwn
              ? 'У вас пока нет фильмов в этой категории'
              : 'У пользователя нет фильмов в этой категории'}
          </p>
        ) : (
          <div className="profile-moviesgrid">
            {movies.map((movie) => (
              <Link
                key={movie.kinopoiskId}
                to={`/elysium/movie/${movie.kinopoiskId}`}
                className="profile-moviecard"
              >
                <img
                  src={movie.posterUrlPreview}
                  alt={getMovieName(movie)}
                  className="profile-movieposter"
                />
                <div className="profile-movieinfo">
                  <p className="profile-moviename">{getMovieName(movie)}</p>
                  <p className="profile-movieyear">{movie.year}</p>
                  {isOwn && (
                    <span className="profile-moviestatus">
                      {STATUS_LABELS[movie.status]}
                    </span>
                  )}
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}