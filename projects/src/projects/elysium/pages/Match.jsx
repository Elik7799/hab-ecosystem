import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/ElysiumAuthContext'
import { useSocket } from '../context/ElysiumSocketContext'
import { getMovieName, getMoviePath } from '../../../utils/ElysiumMovieName'
import { showSuccess, showError } from '../../../utils/ElysiumToast'

const API_URL_BACKEND = 'https://hab-ecosystem.onrender.com/api'

const CRITERIA = [
  { value: 'common_want', label: 'Общие из «Буду смотреть»' },
  { value: 'common_all', label: 'Общие из всех коллекций' },
  { value: 'all_want', label: 'Все из «Буду смотреть»' },
  { value: 'all_movies', label: 'Все из коллекций' },
]

const PHASE = { SETUP: 'setup', WAITING: 'waiting', VOTING: 'voting', RESULT: 'result', EMPTY: 'empty' }

export default function ElysiumMatch() {
  const { token, user: currentUser } = useAuth()
  const { socket } = useSocket()

  const [phase, setPhase] = useState(PHASE.SETUP)
  const [friends, setFriends] = useState([])
  const [invitedFriends, setInvitedFriends] = useState([])
  const [criterion, setCriterion] = useState('common_want')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [invitations, setInvitations] = useState([])
  const [activeRoomId, setActiveRoomId] = useState(null)
  const [activeRoom, setActiveRoom] = useState(null)
  const [participants, setParticipants] = useState([])
  const [movies, setMovies] = useState([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [approved, setApproved] = useState([])
  const [myVoted, setMyVoted] = useState(null)
  const [waitingForOthers, setWaitingForOthers] = useState(false)
  const [currentRound, setCurrentRound] = useState(1)

  const activeRoomIdRef = useRef(null)
  useEffect(() => { activeRoomIdRef.current = activeRoomId }, [activeRoomId])

  const isOrganizer = participants.find(p => p.id === currentUser?.id)?.is_organizer

  useEffect(() => {
    if (!token) return
    loadFriends(); loadRooms()
    const saved = localStorage.getItem('activeRoomId')
    if (saved) {
      openRoom(saved).then(room => {
        if (!room) { localStorage.removeItem('activeRoomId'); return }
        if (room.status === 'cancelled') { localStorage.removeItem('activeRoomId'); return }
        if (room.status === 'voting') setPhase(PHASE.VOTING)
        else if (room.status === 'waiting') setPhase(PHASE.WAITING)
      })
    }
  }, [token])

  useEffect(() => {
    if (!socket) return
    const onInvite = () => { loadRooms(); showSuccess('Новое приглашение') }
    const onUpdated = () => { const id = activeRoomIdRef.current; if (id) openRoom(id) }
    const onRoundStarted = ({ roomId }) => {
      if (String(roomId) !== String(activeRoomIdRef.current)) return
      setMyVoted(null); setWaitingForOthers(false); setApproved([]); setCurrentIndex(0)
      loadVotingMovies(roomId)
    }
    const onCancelled = ({ roomId, reason }) => {
      if (String(roomId) !== String(activeRoomIdRef.current)) return
      localStorage.removeItem('activeRoomId')
      setPhase(PHASE.SETUP); setActiveRoom(null); setActiveRoomId(null)
      setParticipants([]); setMovies([]); setApproved([]); setMyVoted(null); setCurrentRound(1)
      showError(reason === 'disconnect' ? 'Участник отключился' : 'Комната закрыта')
      loadRooms()
    }
    socket.on('match:invite', onInvite)
    socket.on('match:updated', onUpdated)
    socket.on('match:round_started', onRoundStarted)
    socket.on('match:cancelled', onCancelled)
    return () => {
      socket.off('match:invite', onInvite)
      socket.off('match:updated', onUpdated)
      socket.off('match:round_started', onRoundStarted)
      socket.off('match:cancelled', onCancelled)
    }
  }, [socket])

  useEffect(() => {
    if (!socket || !activeRoomId) return
    socket.emit('match:join_room', { roomId: activeRoomId })
    return () => { socket.emit('match:leave_room', { roomId: activeRoomId }) }
  }, [socket, activeRoomId])

  useEffect(() => {
    if (!activeRoomId) return
    if (phase !== PHASE.WAITING && phase !== PHASE.VOTING) return
    const iv = setInterval(() => openRoom(activeRoomId), 5000)
    return () => clearInterval(iv)
  }, [activeRoomId, phase])

  const loadFriends = async () => {
    try {
      const r = await fetch(`${API_URL_BACKEND}/friends`, { headers: { Authorization: `Bearer ${token}` } })
      const d = await r.json()
      setFriends(d.friends || [])
    } catch {}
  }
  const loadRooms = async () => {
    try {
      const r = await fetch(`${API_URL_BACKEND}/match/rooms`, { headers: { Authorization: `Bearer ${token}` } })
      const d = await r.json()
      setInvitations(d.invitations || [])
    } catch {}
  }
  const openRoom = async (id) => {
    try {
      const r = await fetch(`${API_URL_BACKEND}/match/rooms/${id}`, { headers: { Authorization: `Bearer ${token}` } })
      if (!r.ok) { localStorage.removeItem('activeRoomId'); setActiveRoomId(null); setActiveRoom(null); setPhase(PHASE.SETUP); return null }
      const d = await r.json()
      if (d.room.status === 'cancelled') {
        localStorage.removeItem('activeRoomId'); setActiveRoomId(null); setActiveRoom(null); setPhase(PHASE.SETUP)
        showError('Комната закрыта'); return null
      }
      setActiveRoom(d.room); setParticipants(d.participants || [])
      setActiveRoomId(id); setCurrentRound(d.room.current_round || 1)
      return d.room
    } catch { return null }
  }
  const loadVotingMovies = async (roomId) => {
    const id = roomId || activeRoomIdRef.current
    if (!id) return
    try {
      const r = await fetch(`${API_URL_BACKEND}/match/rooms/${id}/movies`, { headers: { Authorization: `Bearer ${token}` } })
      if (!r.ok) return
      const d = await r.json()
      if (d.movies?.length > 0) {
        setMovies(d.movies); setCurrentRound(d.round || 1)
        setCurrentIndex(0); setMyVoted(null); setWaitingForOthers(false)
        setPhase(PHASE.VOTING)
      } else setError('Нет фильмов')
    } catch {}
  }

  const toggleFriend = (fid) => {
    setInvitedFriends(p => p.includes(fid) ? p.filter(x => x !== fid) : [...p, fid])
  }

  const handleSend = async (e) => {
    e.preventDefault(); setError('')
    if (invitedFriends.length === 0) { setError('Выберите друга'); return }
    setLoading(true)
    try {
      const r = await fetch(`${API_URL_BACKEND}/match/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ friendIds: invitedFriends, criterion }),
      })
      const d = await r.json()
      if (!r.ok) { setError(d.error || 'Ошибка'); showError(d.error || 'Ошибка'); return }
      localStorage.setItem('activeRoomId', d.id)
      await openRoom(d.id); setPhase(PHASE.WAITING)
      showSuccess('Комната создана'); loadRooms()
    } catch { setError('Ошибка'); showError('Ошибка') }
    finally { setLoading(false) }
  }

  const handleRespond = async (roomId, accept) => {
    try {
      await fetch(`${API_URL_BACKEND}/match/rooms/${roomId}/respond`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ accept }),
      })
      if (accept) {
        localStorage.setItem('activeRoomId', roomId)
        await openRoom(roomId); setPhase(PHASE.WAITING)
        if (socket) socket.emit('match:join_room', { roomId })
      } else loadRooms()
    } catch {}
  }

  const handleStartRound = async () => {
    if (!activeRoomId) return
    setLoading(true); setError('')
    try {
      const r = await fetch(`${API_URL_BACKEND}/match/rooms/${activeRoomId}/round`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      })
      const d = await r.json()
      if (!r.ok || !d.movies?.length) {
        setError(d.error || 'Нет фильмов'); showError(d.error || 'Нет фильмов'); setLoading(false); return
      }
      setMovies(d.movies); setCurrentRound(d.round || 1)
      setCurrentIndex(0); setMyVoted(null); setWaitingForOthers(false); setApproved([])
      setPhase(PHASE.VOTING)
    } catch { setError('Ошибка'); showError('Ошибка') }
    finally { setLoading(false) }
  }

  const handleVote = async (vote) => {
    const movie = movies[currentIndex]
    if (!movie) return
    try {
      await fetch(`${API_URL_BACKEND}/match/rooms/${activeRoomId}/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ movieId: movie.kinopoiskId, movieType: movie.type, vote }),
      })
    } catch {}
    setMyVoted(vote); setWaitingForOthers(true)
    const mid = movie.kinopoiskId
    const isLast = currentIndex + 1 >= movies.length
    const check = async () => {
      try {
        const r = await fetch(`${API_URL_BACKEND}/match/rooms/${activeRoomId}/votes/${mid}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        const d = await r.json()
        if (!d.allVoted) { setTimeout(check, 1500); return }
        if (!isLast) {
          setCurrentIndex(p => p + 1); setMyVoted(null); setWaitingForOthers(false)
        } else {
          const rr = await fetch(`${API_URL_BACKEND}/match/rooms/${activeRoomId}/results`, {
            headers: { Authorization: `Bearer ${token}` },
          })
          const rd = await rr.json()
          const list = Array.isArray(rd.approved) ? rd.approved : []
          setApproved(list); setWaitingForOthers(false); setMyVoted(null)
          setPhase(list.length > 0 ? PHASE.RESULT : PHASE.EMPTY)
        }
      } catch { setTimeout(check, 1500) }
    }
    setTimeout(check, 1500)
  }

  const handleNextRound = async () => {
    setLoading(true); setError('')
    try {
      const r = await fetch(`${API_URL_BACKEND}/match/rooms/${activeRoomId}/next-round`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      })
      const d = await r.json()
      if (!r.ok || !d.movies?.length) { setError(d.error || 'Ошибка'); setLoading(false); return }
      setMovies(d.movies); setCurrentRound(d.round)
      setCurrentIndex(0); setApproved([]); setMyVoted(null); setWaitingForOthers(false)
      setPhase(PHASE.VOTING)
    } catch { setError('Ошибка') } finally { setLoading(false) }
  }

  const handleCancel = async () => {
    if (!activeRoomId || !token) return
    try {
      await fetch(`${API_URL_BACKEND}/match/rooms/${activeRoomId}/cancel`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${token}` },
      })
    } catch {}
    localStorage.removeItem('activeRoomId')
    setPhase(PHASE.SETUP); setInvitedFriends([]); setMovies([]); setCurrentIndex(0)
    setApproved([]); setActiveRoom(null); setActiveRoomId(null); setParticipants([])
    setError(''); setMyVoted(null); setWaitingForOthers(false); setCurrentRound(1)
    loadRooms()
  }

  const progress = movies.length ? Math.round(((currentIndex + (waitingForOthers ? 0.5 : 0)) / movies.length) * 100) : 0
  const allAccepted = participants.length > 0 && participants.every(p => p.responded && !p.declined)
  const someoneDeclined = participants.find(p => p.declined)
  const canVote = !myVoted && !waitingForOthers

  return (
    <div className="match-body">
      {invitations.length > 0 && phase === PHASE.SETUP && (
        <div className="match-invitations">
          <h2 className="match-heading">Вас приглашают</h2>
          {invitations.map(inv => (
            <div key={inv.room_id} className="match-invitation-card">
              <p className="match-invitation-text">
                <strong>@{inv.organizer_name}</strong> приглашает подобрать фильм
              </p>
              <div className="match-invitation-actions">
                <button type="button" className="match-submit" onClick={() => handleRespond(inv.room_id, true)}>Принять</button>
                <button type="button" className="match-cancel" onClick={() => handleRespond(inv.room_id, false)}>Отклонить</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {phase === PHASE.SETUP && (
        <>
          <h1 className="match-title">Создать подбор</h1>
          <p className="match-subtitle">Выберите друзей и критерий</p>
          <form className="match-form" onSubmit={handleSend}>
            <div className="match-section">
              <h2 className="match-heading">
                Кого пригласить
                {invitedFriends.length > 0 && <span className="match-count">{invitedFriends.length}</span>}
              </h2>
              <div className="match-friends">
                {friends.length === 0 ? (
                  <p className="match-empty">У вас пока нет друзей.</p>
                ) : friends.map(f => (
                  <button
                    type="button"
                    key={f.id}
                    className={invitedFriends.includes(f.id) ? 'match-friend match-friend-active' : 'match-friend'}
                    onClick={() => toggleFriend(f.id)}
                  >@{f.name}</button>
                ))}
              </div>
            </div>
            <div className="match-section">
              <h2 className="match-heading">Критерий</h2>
              <div className="match-criteria">
                {CRITERIA.map(c => (
                  <label key={c.value} className={criterion === c.value ? 'match-criterion match-criterion-active' : 'match-criterion'}>
                    <input type="radio" name="criterion" value={c.value} checked={criterion === c.value} onChange={e => setCriterion(e.target.value)} />
                    <span>{c.label}</span>
                  </label>
                ))}
              </div>
            </div>
            {error && <p className="match-error">{error}</p>}
            <button type="submit" className="match-submit" disabled={loading || friends.length === 0}>
              {loading ? 'Создание...' : 'Отправить'}
            </button>
          </form>
        </>
      )}

      {phase === PHASE.WAITING && activeRoom && (
        <div className="match-waiting">
          <h1 className="match-title">Ждём ответов</h1>
          <div className="match-join-list">
            {participants.map(p => {
              let st = '... Ждём', cls = 'match-join-item'
              if (p.declined) { st = '✕ Отклонил'; cls = 'match-join-item match-join-item-declined' }
              else if (p.responded) { st = '✓ Готов'; cls = 'match-join-item match-join-item-joined' }
              return (
                <div key={p.id} className={cls}>
                  <span className="match-join-name">@{p.name}
                    {p.is_organizer && <span className="match-join-badge">организатор</span>}
                  </span>
                  <span className="match-join-status">{st}</span>
                </div>
              )
            })}
          </div>
          {error && <p className="match-error">{error}</p>}
          {someoneDeclined ? (
            <div className="match-declined-notice">
              <p>@{someoneDeclined.name} отклонил. Комната закрыта.</p>
              <button type="button" className="match-submit" onClick={handleCancel}>Вернуться</button>
            </div>
          ) : (
            <>
              {isOrganizer && (
                <button type="button" className="match-submit" disabled={!allAccepted || loading} onClick={handleStartRound}>
                  {loading ? 'Загрузка...' : allAccepted ? 'Начать голосование' : 'Ждём всех'}
                </button>
              )}
              {!isOrganizer && <p className="match-subtitle">Организатор запустит голосование</p>}
              <button type="button" className="match-cancel" onClick={handleCancel}>Отменить</button>
            </>
          )}
        </div>
      )}

      {phase === PHASE.VOTING && movies.length > 0 && movies[currentIndex] && (
        <div className="match-voting">
          <div className="match-progress"><div className="match-progress-bar" style={{ width: `${progress}%` }} /></div>
          <p className="match-voting-info">Раунд {currentRound} · Фильм {currentIndex + 1} из {movies.length}</p>
          <p className="match-voter">Голосует: <strong>@{currentUser?.name}</strong></p>
          {waitingForOthers && <p className="match-voting-info">Ждём остальных...</p>}
          <div className="match-voting-card">
            <img src={movies[currentIndex].posterUrlPreview} alt={getMovieName(movies[currentIndex])} className="match-poster" />
            <p className="match-name">{getMovieName(movies[currentIndex])}</p>
            <p className="match-year">{movies[currentIndex].year}</p>
          </div>
          <div className="match-vote-buttons">
            <button
              type="button"
              className={canVote ? 'match-vote match-vote-no' : 'match-vote match-vote-no match-vote-disabled'}
              onClick={() => canVote && handleVote('no')}
              disabled={!canVote}
            >✕</button>
            <button
              type="button"
              className={canVote ? 'match-vote match-vote-yes' : 'match-vote match-vote-yes match-vote-disabled'}
              onClick={() => canVote && handleVote('yes')}
              disabled={!canVote}
            >✓</button>
          </div>
          {myVoted === 'yes' && <p className="match-voting-info">Ты проголосовал: ✓</p>}
          {myVoted === 'no' && <p className="match-voting-info">Ты проголосовал: ✕</p>}
          <button type="button" className="match-cancel" onClick={handleCancel}>Отменить</button>
        </div>
      )}

      {phase === PHASE.RESULT && approved.length > 0 && (
        <div className="match-result">
          {approved.length === 1 ? (
            <>
              <h2 className="match-heading">🎉 Ваш фильм!</h2>
              <p className="match-subtitle">Все согласны</p>
            </>
          ) : (
            <>
              <h2 className="match-heading">Одобрено: {approved.length}</h2>
              <p className="match-subtitle">Раунд {currentRound}. Можно запустить ещё.</p>
            </>
          )}
          <div className="match-approved">
            {approved.map(m => {
              const path = getMoviePath(m)
              if (!path) return null
              return (
                <Link key={`${m.kinopoiskId}:${m.type}`} to={path} className="match-approved-item">
                  <img src={m.posterUrlPreview} alt={getMovieName(m)} className="match-poster" />
                  <p className="match-name">{getMovieName(m)}</p>
                  <p className="match-year">{m.year && m.year !== 0 ? m.year : '—'}</p>
                </Link>
              )
            })}
          </div>
          {approved.length > 1 && isOrganizer && (
            <button type="button" className="match-submit" onClick={handleNextRound} disabled={loading}>
              {loading ? 'Загрузка...' : 'Голосовать ещё'}
            </button>
          )}
          {approved.length > 1 && !isOrganizer && (
            <p className="match-subtitle">Организатор может запустить ещё раунд</p>
          )}
          <button type="button" className="match-cancel" onClick={handleCancel}>
            {approved.length === 1 ? 'Начать заново' : 'Отменить'}
          </button>
        </div>
      )}

      {phase === PHASE.EMPTY && (
        <div className="match-result">
          <h2 className="match-heading">Ничего не подошло</h2>
          <button type="button" className="match-submit" onClick={handleCancel}>Начать заново</button>
        </div>
      )}

      {phase !== PHASE.SETUP && !activeRoom && (
        <div className="match-result">
          <h2 className="match-heading">Загрузка...</h2>
          <button
            type="button"
            className="match-submit"
            onClick={() => {
              localStorage.removeItem('activeRoomId')
              setPhase(PHASE.SETUP); setActiveRoom(null); setActiveRoomId(null)
              setParticipants([]); setMovies([]); setApproved([]); setMyVoted(null); setCurrentRound(1)
              loadRooms()
            }}
          >Вернуться</button>
        </div>
      )}
    </div>
  )
}