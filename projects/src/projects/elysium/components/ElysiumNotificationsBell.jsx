import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell } from 'lucide-react'
import { useAuth } from '../context/ElysiumAuthContext'
import { useSocket } from '../context/ElysiumSocketContext'

const API_URL_BACKEND = import.meta.env.VITE_API_URL || 'http://localhost:5000/api'

export default function ElysiumNotificationsBell() {
  const { token } = useAuth()
  const { socket } = useSocket()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [notifications, setNotifications] = useState([])
  const [unreadCount, setUnreadCount] = useState(0)
  const dropdownRef = useRef(null)

  const loadNotifications = async () => {
    if (!token) return
    try {
      const res = await fetch(`${API_URL_BACKEND}/notifications`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return
      const data = await res.json()
      setNotifications(data.notifications || [])
      setUnreadCount(data.unreadCount || 0)
    } catch (err) {
      console.error(err)
    }
  }

  useEffect(() => {
    loadNotifications()
    const interval = setInterval(loadNotifications, 60000)
    return () => clearInterval(interval)
  }, [token])

  useEffect(() => {
    if (!socket) return
    const handleNotif = (data) => {
      loadNotifications()
    }
    socket.on('notification', handleNotif)
    return () => socket.off('notification', handleNotif)
  }, [socket])

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleClick = async (n) => {
    try {
      await fetch(`${API_URL_BACKEND}/notifications/${n.id}/read`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
      })
    } catch (err) {
      console.error(err)
    }

    setNotifications((prev) =>
      prev.map((item) => (item.id === n.id ? { ...item, read: true } : item))
    )
    setUnreadCount((prev) => Math.max(0, prev - 1))

    if (n.link) navigate(`/elysium${n.link}`)
    setOpen(false)
  }

  const handleReadAll = async () => {
    try {
      await fetch(`${API_URL_BACKEND}/notifications/read-all`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
      })
      setNotifications((prev) => prev.map((item) => ({ ...item, read: true })))
      setUnreadCount(0)
    } catch (err) {
      console.error(err)
    }
  }

  const formatTime = (dateStr) => {
    const date = new Date(dateStr)
    const now = new Date()
    const diff = Math.floor((now - date) / 1000)

    if (diff < 60) return 'только что'
    if (diff < 3600) return `${Math.floor(diff / 60)} мин назад`
    if (diff < 86400) return `${Math.floor(diff / 3600)} ч назад`
    if (diff < 604800) return `${Math.floor(diff / 86400)} дн назад`
    return date.toLocaleDateString('ru-RU')
  }

  return (
    <div className="notif-wrapper" ref={dropdownRef}>
      <button
        type="button"
        className="header-button notif-btn"
        onClick={() => setOpen((prev) => !prev)}
        title="Уведомления"
      >
        <Bell />
        {unreadCount > 0 && (
          <span className="notif-badge">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="notif-dropdown">
          <div className="notif-header">
            <span className="notif-title">Уведомления</span>
            {unreadCount > 0 && (
              <button
                type="button"
                className="notif-read-all"
                onClick={handleReadAll}
              >
                Прочитать все
              </button>
            )}
          </div>

          <div className="notif-list">
            {notifications.length === 0 ? (
              <div className="notif-empty">Уведомлений нет</div>
            ) : (
              notifications.map((n) => (
                <button
                  type="button"
                  key={n.id}
                  className={
                    n.read ? 'notif-item' : 'notif-item notif-item-unread'
                  }
                  onClick={() => handleClick(n)}
                >
                  <p className="notif-message">{n.message}</p>
                  <span className="notif-time">{formatTime(n.created_at)}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}