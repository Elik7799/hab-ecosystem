import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/ElysiumAuthContext'
import { useSocket } from '../context/ElysiumSocketContext'
import { showSuccess, showError } from '../../../utils/ElysiumToast'

const API_URL_BACKEND = 'https://hab-ecosystem.onrender.com/api'

export default function ElysiumFriends() {
  const { token, user: currentUser } = useAuth()
  const { socket, onlineUsers } = useSocket()

  const [friends, setFriends] = useState([])
  const [requests, setRequests] = useState([])
  const [searchName, setSearchName] = useState('')
  const [searchResult, setSearchResult] = useState(null)
  const [searchError, setSearchError] = useState('')
  const [searching, setSearching] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const loadFriends = useCallback(async () => {
    if (!token) return
    try {
      const res = await fetch(`${API_URL_BACKEND}/friends`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      setFriends(data.friends || [])
      setRequests(data.requests || [])
    } catch (err) {
      console.error(err)
      setError('Не удалось загрузить друзей')
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    loadFriends()
  }, [loadFriends])

  useEffect(() => {
    if (!socket) return
    const handleUpdate = () => {
      loadFriends()
    }
    socket.on('friends:updated', handleUpdate)
    return () => socket.off('friends:updated', handleUpdate)
  }, [socket, loadFriends])

  const handleSearch = async (e) => {
    e.preventDefault()
    setSearchError('')
    setSearchResult(null)

    if (!searchName.trim()) {
      setSearchError('Введите ник')
      return
    }

    setSearching(true)

    try {
      const res = await fetch(
        `${API_URL_BACKEND}/users/search?name=${encodeURIComponent(searchName)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      )

      const data = await res.json()

      if (!res.ok) {
        setSearchError(data.error || 'Пользователь не найден')
        return
      }

      setSearchResult(data)
    } catch (err) {
      setSearchError('Ошибка поиска')
      console.error(err)
    } finally {
      setSearching(false)
    }
  }

  const handleAddFriend = async (user) => {
    try {
      const res = await fetch(`${API_URL_BACKEND}/friends`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ friendId: user.id }),
      })

      const data = await res.json()

      if (!res.ok) {
        showError(data.error || 'Ошибка отправки')
        return
      }

      setSearchResult(null)
      setSearchName('')
      setSearchError('')
      showSuccess('Заявка отправлена!')
    } catch (err) {
      console.error(err)
      showError('Ошибка отправки')
    }
  }

  const handleAccept = async (request) => {
    try {
      const res = await fetch(
        `${API_URL_BACKEND}/friends/${request.friendship_id}`,
        {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}` },
        }
      )

      if (!res.ok) throw new Error('Ошибка')

      showSuccess('Заявка принята')
      loadFriends()
    } catch (err) {
      console.error(err)
      showError('Ошибка')
    }
  }

  const handleDecline = async (request) => {
    try {
      const res = await fetch(
        `${API_URL_BACKEND}/friends/${request.friendship_id}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }
      )

      if (!res.ok) throw new Error('Ошибка')

      showSuccess('Заявка отклонена')
      loadFriends()
    } catch (err) {
      console.error(err)
      showError('Ошибка')
    }
  }

  const handleRemove = async (friend) => {
    if (!confirm('Удалить из друзей?')) return

    try {
      const res = await fetch(
        `${API_URL_BACKEND}/friends/${friend.friendship_id}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }
      )

      if (!res.ok) throw new Error('Ошибка')

      showSuccess('Удалено из друзей')
      loadFriends()
    } catch (err) {
      console.error(err)
      showError('Ошибка')
    }
  }

  const isOnline = (userId) => onlineUsers.includes(userId)

  if (loading) {
    return (
      <div className="friends-body">
        <p className="friends-empty">Загрузка...</p>
      </div>
    )
  }

  return (
    <div className="friends-body">
      <h1 className="friends-title">Друзья</h1>

      {error && <p className="friends-error">{error}</p>}

      <div className="friends-search">
        <h2 className="friends-heading">Найти друзей</h2>
        <form className="friends-searchform" onSubmit={handleSearch}>
          <input
            type="text"
            className="friends-searchinput"
            placeholder="Введите ник пользователя..."
            value={searchName}
            onChange={(e) => setSearchName(e.target.value)}
          />
          <button
            type="submit"
            className="friends-searchbtn"
            disabled={searching}
          >
            {searching ? 'Поиск...' : 'Найти'}
          </button>
        </form>

        {searchError && <p className="friends-error">{searchError}</p>}

        {searchResult && (
          <div className="friends-card">
            <div className="friends-info">
              <p className="friends-name">@{searchResult.name}</p>
            </div>
            <button
              className="friends-action friends-actionprimary"
              onClick={() => handleAddFriend(searchResult)}
            >
              Добавить
            </button>
          </div>
        )}
      </div>

      {requests.length > 0 && (
        <div className="friends-section">
          <h2 className="friends-heading">
            Заявки <span className="friends-count">{requests.length}</span>
          </h2>
          <div className="friends-list">
            {requests.map((request) => (
              <div key={request.friendship_id} className="friends-card">
                <div className="friends-info">
                  <Link
                    to={`/elysium/profile/${request.id}`}
                    className="friends-name-link"
                  >
                    @{request.name}
                  </Link>
                  {isOnline(request.id) && (
                    <span className="online-dot" title="Онлайн" />
                  )}
                </div>
                <div className="friends-actions">
                  <button
                    className="friends-actionprimary"
                    onClick={() => handleAccept(request)}
                  >
                    Принять
                  </button>
                  <button
                    className="friends-actionsecondary"
                    onClick={() => handleDecline(request)}
                  >
                    Отклонить
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="friends-section">
        <h2 className="friends-heading">
          Мои друзья <span className="friends-count">{friends.length}</span>
        </h2>

        {friends.length === 0 ? (
          <p className="friends-empty">
            У вас пока нет друзей. Найдите их по нику выше.
          </p>
        ) : (
          <div className="friends-list">
            {friends.map((friend) => (
              <div key={friend.friendship_id} className="friends-card">
                <div className="friends-info">
                  <Link
                    to={`/elysium/profile/${friend.id}`}
                    className="friends-name-link"
                  >
                    @{friend.name}
                  </Link>
                  {isOnline(friend.id) && (
                    <span className="online-dot" title="Онлайн" />
                  )}
                </div>
                <button
                  className="friends-actiondanger"
                  onClick={() => handleRemove(friend)}
                >
                  Удалить
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}