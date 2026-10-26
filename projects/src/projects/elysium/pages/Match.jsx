import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/ElysiumAuthContext'
import { useSocket } from '../context/ElysiumSocketContext'
import { getMovieName } from '../../../utils/ElysiumMovieName'
import { showSuccess, showError } from '../../../utils/ElysiumToast'

const API_URL_BACKEND = 'https://hab-ecosystem.onrender.com/api'

const CRITERIA = [
    { value: 'common_want', label: 'Общие из «Буду смотреть»' },
    { value: 'common_all', label: 'Общие из всех коллекций' },
    { value: 'all_want', label: 'Все из «Буду смотреть»' },
    { value: 'all_movies', label: 'Все фильмы из коллекций' },
]

const PHASE = {
    SETUP: 'setup',
    WAITING: 'waiting',
    VOTING: 'voting',
    RESULT: 'result',
    EMPTY: 'empty',
}

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
    useEffect(() => {
        activeRoomIdRef.current = activeRoomId
    }, [activeRoomId])

    const isOrganizer = participants.find(
        (p) => p.id === currentUser?.id
    )?.is_organizer

    useEffect(() => {
        if (!token) return

        loadFriends()
        loadRooms()

        const savedRoomId = localStorage.getItem('activeRoomId')
        if (savedRoomId) {
            openRoom(savedRoomId).then((room) => {
                if (!room) {
                    localStorage.removeItem('activeRoomId')
                    return
                }
                if (room.status === 'cancelled') {
                    localStorage.removeItem('activeRoomId')
                    return
                }
                if (room.status === 'voting') {
                    setPhase(PHASE.VOTING)
                } else if (room.status === 'waiting') {
                    setPhase(PHASE.WAITING)
                }
            })
        }
    }, [token])

    useEffect(() => {
        if (!socket) return

        const handleInvite = () => {
            loadRooms()
            showSuccess('Новое приглашение в подбор!')
        }

        const handleUpdated = () => {
            const id = activeRoomIdRef.current
            if (id) {
                openRoom(id)
            }
        }

        const handleRoundStarted = ({ roomId }) => {
            const currentId = activeRoomIdRef.current
            if (String(roomId) !== String(currentId)) return

            setMyVoted(null)
            setWaitingForOthers(false)
            setApproved([])
            setCurrentIndex(0)
            loadVotingMovies(roomId)
        }

        const handleCancelled = ({ roomId, reason }) => {
            const currentId = activeRoomIdRef.current
            if (String(roomId) !== String(currentId)) return

            localStorage.removeItem('activeRoomId')
            setPhase(PHASE.SETUP)
            setActiveRoom(null)
            setActiveRoomId(null)
            setParticipants([])
            setMovies([])
            setApproved([])
            setMyVoted(null)
            setCurrentRound(1)

            if (reason === 'disconnect') {
                showError('Участник отключился — комната закрыта')
            } else {
                showError('Комната закрыта')
            }

            loadRooms()
        }

        socket.on('match:invite', handleInvite)
        socket.on('match:updated', handleUpdated)
        socket.on('match:round_started', handleRoundStarted)
        socket.on('match:cancelled', handleCancelled)

        return () => {
            socket.off('match:invite', handleInvite)
            socket.off('match:updated', handleUpdated)
            socket.off('match:round_started', handleRoundStarted)
            socket.off('match:cancelled', handleCancelled)
        }
    }, [socket])

    useEffect(() => {
        if (!socket || !activeRoomId) return
        socket.emit('match:join_room', { roomId: activeRoomId })

        return () => {
            socket.emit('match:leave_room', { roomId: activeRoomId })
        }
    }, [socket, activeRoomId])

    useEffect(() => {
        if (!activeRoomId) return
        if (phase !== PHASE.WAITING && phase !== PHASE.VOTING) return

        const interval = setInterval(() => {
            openRoom(activeRoomId)
        }, 5000)

        return () => clearInterval(interval)
    }, [activeRoomId, phase])

    const loadFriends = async () => {
        try {
            const res = await fetch(`${API_URL_BACKEND}/friends`, {
                headers: { Authorization: `Bearer ${token}` },
            })
            const data = await res.json()
            setFriends(data.friends || [])
        } catch (err) {
            console.error(err)
        }
    }

    const loadRooms = async () => {
        try {
            const res = await fetch(`${API_URL_BACKEND}/match/rooms`, {
                headers: { Authorization: `Bearer ${token}` },
            })
            const data = await res.json()
            setInvitations(data.invitations || [])
        } catch (err) {
            console.error(err)
        }
    }

    const openRoom = async (id) => {
        try {
            const res = await fetch(`${API_URL_BACKEND}/match/rooms/${id}`, {
                headers: { Authorization: `Bearer ${token}` },
            })

            if (!res.ok) {
                localStorage.removeItem('activeRoomId')
                setActiveRoomId(null)
                setActiveRoom(null)
                setPhase(PHASE.SETUP)
                return null
            }

            const data = await res.json()

            if (data.room.status === 'cancelled') {
                localStorage.removeItem('activeRoomId')
                setActiveRoomId(null)
                setActiveRoom(null)
                setPhase(PHASE.SETUP)
                showError('Комната закрыта')
                return null
            }

            setActiveRoom(data.room)
            setParticipants(data.participants || [])
            setActiveRoomId(id)
            setCurrentRound(data.room.current_round || 1)
            return data.room
        } catch (err) {
            console.error(err)
            return null
        }
    }

    const loadVotingMovies = async (roomId) => {
        const id = roomId || activeRoomIdRef.current
        if (!id) return

        try {
            const res = await fetch(`${API_URL_BACKEND}/match/rooms/${id}/movies`, {
                headers: { Authorization: `Bearer ${token}` },
            })
            if (!res.ok) return
            const data = await res.json()

            if (data.movies && data.movies.length > 0) {
                setMovies(data.movies)
                setCurrentRound(data.round || 1)
                setCurrentIndex(0)
                setMyVoted(null)
                setWaitingForOthers(false)
                setPhase(PHASE.VOTING)
            } else {
                setError('Нет фильмов для голосования')
            }
        } catch (err) {
            console.error(err)
        }
    }

    const toggleFriend = (friendId) => {
        setInvitedFriends((prev) =>
            prev.includes(friendId)
                ? prev.filter((id) => id !== friendId)
                : [...prev, friendId]
        )
    }

    const handleSend = async (e) => {
        e.preventDefault()
        setError('')

        if (invitedFriends.length === 0) {
            setError('Выберите хотя бы одного друга')
            return
        }

        setLoading(true)

        try {
            const res = await fetch(`${API_URL_BACKEND}/match/rooms`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ friendIds: invitedFriends, criterion }),
            })

            const data = await res.json()
            if (!res.ok) {
                setError(data.error || 'Ошибка создания')
                showError(data.error || 'Ошибка создания')
                return
            }

            localStorage.setItem('activeRoomId', data.id)
            await openRoom(data.id)
            setPhase(PHASE.WAITING)
            showSuccess('Комната создана')
            loadRooms()
        } catch (err) {
            setError('Ошибка создания комнаты')
            showError('Ошибка создания комнаты')
            console.error(err)
        } finally {
            setLoading(false)
        }
    }

    const handleRespond = async (roomId, accept) => {
        try {
            await fetch(`${API_URL_BACKEND}/match/rooms/${roomId}/respond`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ accept }),
            })

            if (accept) {
                localStorage.setItem('activeRoomId', roomId)
                await openRoom(roomId)
                setPhase(PHASE.WAITING)
                if (socket) socket.emit('match:join_room', { roomId })
            } else {
                loadRooms()
            }
        } catch (err) {
            console.error(err)
        }
    }

    const handleStartRound = async () => {
        if (!activeRoomId) return
        setLoading(true)
        setError('')

        try {
            const res = await fetch(
                `${API_URL_BACKEND}/match/rooms/${activeRoomId}/round`,
                {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${token}` },
                }
            )
            const data = await res.json()

            if (!res.ok) {
                setError(data.error || 'Ошибка запуска')
                showError(data.error || 'Ошибка запуска')
                setLoading(false)
                return
            }

            if (!data.movies || data.movies.length === 0) {
                setError('Нет общих фильмов по этому критерию')
                showError('Нет общих фильмов')
                setLoading(false)
                return
            }

            setMovies(data.movies)
            setCurrentRound(data.round || 1)
            setCurrentIndex(0)
            setMyVoted(null)
            setWaitingForOthers(false)
            setApproved([])
            setPhase(PHASE.VOTING)
        } catch (err) {
            setError('Ошибка запуска голосования')
            showError('Ошибка запуска')
            console.error(err)
        } finally {
            setLoading(false)
        }
    }

    const handleVote = async (vote) => {
        const movie = movies[currentIndex]
        if (!movie) return

        try {
            await fetch(`${API_URL_BACKEND}/match/rooms/${activeRoomId}/vote`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ movieId: movie.kinopoiskId, vote }),
            })
        } catch (err) {
            console.error(err)
        }

        setMyVoted(vote)
        setWaitingForOthers(true)

        const votingMovieId = movie.kinopoiskId
        const isLastMovie = currentIndex + 1 >= movies.length

        const check = async () => {
            try {
                const res = await fetch(
                    `${API_URL_BACKEND}/match/rooms/${activeRoomId}/votes/${votingMovieId}`,
                    { headers: { Authorization: `Bearer ${token}` } }
                )
                const data = await res.json()

                if (!data.allVoted) {
                    setTimeout(check, 1500)
                    return
                }

                if (!isLastMovie) {
                    setCurrentIndex((prev) => prev + 1)
                    setMyVoted(null)
                    setWaitingForOthers(false)
                } else {
                    const resultsRes = await fetch(
                        `${API_URL_BACKEND}/match/rooms/${activeRoomId}/results`,
                        { headers: { Authorization: `Bearer ${token}` } }
                    )
                    const resultsData = await resultsRes.json()

                    const list = Array.isArray(resultsData.approved)
                        ? resultsData.approved
                        : []
                    setApproved(list)
                    setWaitingForOthers(false)
                    setMyVoted(null)
                    setPhase(list.length > 0 ? PHASE.RESULT : PHASE.EMPTY)
                }
            } catch (err) {
                console.error(err)
                setTimeout(check, 1500)
            }
        }

        setTimeout(check, 1500)
    }

    const handleNextRound = async () => {
        setLoading(true)
        setError('')

        try {
            const res = await fetch(
                `${API_URL_BACKEND}/match/rooms/${activeRoomId}/next-round`,
                {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${token}` },
                }
            )
            const data = await res.json()

            if (!res.ok) {
                setError(data.error || 'Ошибка перехода')
                showError(data.error || 'Ошибка')
                setLoading(false)
                return
            }

            if (!data.movies || data.movies.length === 0) {
                setError('Нет фильмов для нового раунда')
                setLoading(false)
                return
            }

            setMovies(data.movies)
            setCurrentRound(data.round)
            setCurrentIndex(0)
            setApproved([])
            setMyVoted(null)
            setWaitingForOthers(false)
            setPhase(PHASE.VOTING)
        } catch (err) {
            setError('Ошибка перехода')
            showError('Ошибка перехода')
            console.error(err)
        } finally {
            setLoading(false)
        }
    }

    const handleCancel = async () => {
        if (!activeRoomId || !token) return

        try {
            await fetch(`${API_URL_BACKEND}/match/rooms/${activeRoomId}/cancel`, {
                method: 'PATCH',
                headers: { Authorization: `Bearer ${token}` },
            })
        } catch (err) {
            console.error(err)
        }

        localStorage.removeItem('activeRoomId')
        setPhase(PHASE.SETUP)
        setInvitedFriends([])
        setMovies([])
        setCurrentIndex(0)
        setApproved([])
        setActiveRoom(null)
        setActiveRoomId(null)
        setParticipants([])
        setError('')
        setMyVoted(null)
        setWaitingForOthers(false)
        setCurrentRound(1)
        loadRooms()
    }

    const progress = movies.length
        ? Math.round(
            ((currentIndex + (waitingForOthers ? 0.5 : 0)) / movies.length) * 100
        )
        : 0

    const allAccepted =
        participants.length > 0 &&
        participants.every((p) => p.responded && !p.declined)

    const someoneDeclined = participants.find((p) => p.declined)
    const canVote = !myVoted && !waitingForOthers

    return (
        <div className="match-body">
            {invitations.length > 0 && phase === PHASE.SETUP && (
                <div className="match-invitations">
                    <h2 className="match-heading">Вас приглашают</h2>
                    {invitations.map((inv) => (
                        <div key={inv.room_id} className="match-invitation-card">
                            <p className="match-invitation-text">
                                <strong>@{inv.organizer_name}</strong> приглашает вас
                                подобрать фильм
                            </p>
                            <div className="match-invitation-actions">
                                <button
                                    type="button"
                                    className="match-submit"
                                    onClick={() => handleRespond(inv.room_id, true)}
                                >
                                    Принять
                                </button>
                                <button
                                    type="button"
                                    className="match-cancel"
                                    onClick={() => handleRespond(inv.room_id, false)}
                                >
                                    Отклонить
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {phase === PHASE.SETUP && (
                <>
                    <h1 className="match-title">Создать подбор</h1>
                    <p className="match-subtitle">
                        Выберите друзей и критерий — им придёт приглашение
                    </p>

                    <form className="match-form" onSubmit={handleSend}>
                        <div className="match-section">
                            <h2 className="match-heading">
                                Кого пригласить
                                {invitedFriends.length > 0 && (
                                    <span className="match-count">{invitedFriends.length}</span>
                                )}
                            </h2>
                            <div className="match-friends">
                                {friends.length === 0 ? (
                                    <p className="match-empty">
                                        У вас пока нет друзей. Добавьте их на странице «Друзья».
                                    </p>
                                ) : (
                                    friends.map((friend) => {
                                        const isSelected = invitedFriends.includes(friend.id)
                                        return (
                                            <button
                                                type="button"
                                                key={friend.id}
                                                className={
                                                    isSelected
                                                        ? 'match-friend match-friend-active'
                                                        : 'match-friend'
                                                }
                                                onClick={() => toggleFriend(friend.id)}
                                            >
                                                @{friend.name}
                                            </button>
                                        )
                                    })
                                )}
                            </div>
                        </div>

                        <div className="match-section">
                            <h2 className="match-heading">Критерий подбора</h2>
                            <div className="match-criteria">
                                {CRITERIA.map((c) => (
                                    <label
                                        key={c.value}
                                        className={
                                            criterion === c.value
                                                ? 'match-criterion match-criterion-active'
                                                : 'match-criterion'
                                        }
                                    >
                                        <input
                                            type="radio"
                                            name="criterion"
                                            value={c.value}
                                            checked={criterion === c.value}
                                            onChange={(e) => setCriterion(e.target.value)}
                                        />
                                        <span>{c.label}</span>
                                    </label>
                                ))}
                            </div>
                        </div>

                        {error && <p className="match-error">{error}</p>}

                        <button
                            type="submit"
                            className="match-submit"
                            disabled={loading || friends.length === 0}
                        >
                            {loading ? 'Создание...' : 'Отправить подбор'}
                        </button>
                    </form>
                </>
            )}

            {phase === PHASE.WAITING && activeRoom && (
                <div className="match-waiting">
                    <h1 className="match-title">Ждём ответов</h1>
                    <p className="match-subtitle">
                        Как только все примут приглашение — начнём голосование
                    </p>

                    <div className="match-join-list">
                        {participants.map((p) => {
                            let status = '... Ждём'
                            let cls = 'match-join-item'
                            if (p.declined) {
                                status = '✕ Отклонил'
                                cls = 'match-join-item match-join-item-declined'
                            } else if (p.responded) {
                                status = '✓ Готов'
                                cls = 'match-join-item match-join-item-joined'
                            }
                            return (
                                <div key={p.id} className={cls}>
                                    <span className="match-join-name">
                                        @{p.name}
                                        {p.is_organizer && (
                                            <span className="match-join-badge">организатор</span>
                                        )}
                                    </span>
                                    <span className="match-join-status">{status}</span>
                                </div>
                            )
                        })}
                    </div>

                    {error && <p className="match-error">{error}</p>}

                    {someoneDeclined ? (
                        <div className="match-declined-notice">
                            <p>
                                @{someoneDeclined.name} отклонил приглашение. Комната закрыта.
                            </p>
                            <button
                                type="button"
                                className="match-submit"
                                onClick={handleCancel}
                            >
                                Вернуться
                            </button>
                        </div>
                    ) : (
                        <>
                            {isOrganizer && (
                                <button
                                    type="button"
                                    className="match-submit"
                                    disabled={!allAccepted || loading}
                                    onClick={handleStartRound}
                                >
                                    {loading
                                        ? 'Загрузка...'
                                        : allAccepted
                                            ? 'Начать голосование'
                                            : 'Ждём всех'}
                                </button>
                            )}

                            {!isOrganizer && (
                                <p className="match-subtitle">
                                    Организатор запустит голосование, когда все будут готовы
                                </p>
                            )}

                            <button
                                type="button"
                                className="match-cancel"
                                onClick={handleCancel}
                            >
                                Отменить
                            </button>
                        </>
                    )}
                </div>
            )}

            {phase === PHASE.VOTING && movies.length > 0 && movies[currentIndex] && (
                <div className="match-voting">
                    <div className="match-progress">
                        <div
                            className="match-progress-bar"
                            style={{ width: `${progress}%` }}
                        />
                    </div>
                    <p className="match-voting-info">
                        Раунд {currentRound} · Фильм {currentIndex + 1} из {movies.length}
                    </p>

                    <p className="match-voter">
                        Голосует: <strong>@{currentUser?.name}</strong>
                    </p>

                    {waitingForOthers && (
                        <p className="match-voting-info">Ждём остальных участников...</p>
                    )}

                    <div className="match-voting-card">
                        <img
                            src={movies[currentIndex].posterUrlPreview}
                            alt={getMovieName(movies[currentIndex])}
                            className="match-poster"
                        />
                        <p className="match-name">{getMovieName(movies[currentIndex])}</p>
                        <p className="match-year">{movies[currentIndex].year}</p>
                    </div>

                    <div className="match-vote-buttons">
                        <button
                            type="button"
                            className={
                                canVote
                                    ? 'match-vote match-vote-no'
                                    : 'match-vote match-vote-no match-vote-disabled'
                            }
                            onClick={() => canVote && handleVote('no')}
                            disabled={!canVote}
                        >
                            ✕
                        </button>
                        <button
                            type="button"
                            className={
                                canVote
                                    ? 'match-vote match-vote-yes'
                                    : 'match-vote match-vote-yes match-vote-disabled'
                            }
                            onClick={() => canVote && handleVote('yes')}
                            disabled={!canVote}
                        >
                            ✓
                        </button>
                    </div>

                    {myVoted === 'yes' && (
                        <p className="match-voting-info">Ты проголосовал: ✓</p>
                    )}
                    {myVoted === 'no' && (
                        <p className="match-voting-info">Ты проголосовал: ✕</p>
                    )}

                    <button
                        type="button"
                        className="match-cancel"
                        onClick={handleCancel}
                    >
                        Отменить
                    </button>
                </div>
            )}

            {phase === PHASE.RESULT && approved.length > 0 && (
                <div className="match-result">
                    {approved.length === 1 ? (
                        <>
                            <h2 className="match-heading">🎉 Ваш фильм!</h2>
                            <p className="match-subtitle">Все согласны — можно смотреть</p>
                        </>
                    ) : (
                        <>
                            <h2 className="match-heading">
                                Одобрено всеми: {approved.length}
                            </h2>
                            <p className="match-subtitle">
                                Раунд {currentRound}. Можно запустить ещё один, чтобы выбрать
                                один фильм.
                            </p>
                        </>
                    )}

                    <div className="match-approved">
                        {approved.map((movie) => (
                            <Link
                                key={movie.kinopoiskId}
                                to={`/elysium/movie/${movie.kinopoiskId}`}
                                className="match-approved-item"
                            >
                                <img
                                    src={movie.posterUrlPreview}
                                    alt={getMovieName(movie)}
                                    className="match-poster"
                                />
                                <p className="match-name">{getMovieName(movie)}</p>
                                <p className="match-year">{movie.year}</p>
                            </Link>
                        ))}
                    </div>

                    {approved.length > 1 && isOrganizer && (
                        <button
                            type="button"
                            className="match-submit"
                            onClick={handleNextRound}
                            disabled={loading}
                        >
                            {loading ? 'Загрузка...' : 'Голосовать ещё'}
                        </button>
                    )}

                    {approved.length > 1 && !isOrganizer && (
                        <p className="match-subtitle">
                            Организатор может запустить ещё раунд
                        </p>
                    )}

                    <button
                        type="button"
                        className="match-cancel"
                        onClick={handleCancel}
                    >
                        {approved.length === 1 ? 'Начать заново' : 'Отменить'}
                    </button>
                </div>
            )}

            {phase === PHASE.EMPTY && (
                <div className="match-result">
                    <h2 className="match-heading">Ничего не подошло</h2>
                    <p className="match-subtitle">
                        Попробуйте другие критерии или пригласите других друзей
                    </p>
                    <button
                        type="button"
                        className="match-submit"
                        onClick={handleCancel}
                    >
                        Начать заново
                    </button>
                </div>
            )}

            {phase !== PHASE.SETUP && !activeRoom && (
                <div className="match-result">
                    <h2 className="match-heading">Загрузка...</h2>
                    <p className="match-subtitle">
                        Если это длится долго — комната могла быть закрыта
                    </p>
                    <button
                        type="button"
                        className="match-submit"
                        onClick={() => {
                            localStorage.removeItem('activeRoomId')
                            setPhase(PHASE.SETUP)
                            setActiveRoom(null)
                            setActiveRoomId(null)
                            setParticipants([])
                            setMovies([])
                            setApproved([])
                            setMyVoted(null)
                            setCurrentRound(1)
                            loadRooms()
                        }}
                    >
                        Вернуться
                    </button>
                </div>
            )}
        </div>
    )
}