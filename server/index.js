require('dotenv').config()
const express = require('express')
const { Pool } = require('pg')
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const cors = require('cors')
const http = require('http')
const { Server } = require('socket.io')

const app = express()
app.use(cors())
app.use(express.json())

// Подключение к БД
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
})

// ───────────────────────── SOCKET.IO ─────────────────────────

const httpServer = http.createServer(app)
const io = new Server(httpServer, {
  cors: {
    origin: 'http://localhost:5173',
    credentials: true,
  },
})

// userId → socketId
const onlineUsers = new Map()

io.use((socket, next) => {
  const token = socket.handshake.auth.token
  if (!token) return next(new Error('Нет токена'))

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    socket.userId = decoded.id
    socket.userName = decoded.name
    next()
  } catch (err) {
    next(new Error('Неверный токен'))
  }
})

io.on('connection', (socket) => {
  const userId = socket.userId
  console.log(`🟢 Подключился: @${socket.userName} (id: ${userId})`)

  onlineUsers.set(userId, socket.id)
  socket.broadcast.emit('user_online', { userId })
  socket.emit('online_users', Array.from(onlineUsers.keys()))

  // Комнаты, в которых пользователь участвует (для отслеживания)
  socket.activeRooms = new Set()

  socket.on('match:join_room', ({ roomId }) => {
    socket.join(`match_room_${roomId}`)
    socket.activeRooms.add(roomId)
  })

  socket.on('match:leave_room', ({ roomId }) => {
    socket.leave(`match_room_${roomId}`)
    socket.activeRooms.delete(roomId)
  })

  socket.on('disconnect', async () => {
    console.log(`🔴 Отключился: @${socket.userName}`)
    onlineUsers.delete(userId)
    socket.broadcast.emit('user_offline', { userId })

    // Если пользователь был в активных комнатах — отменяем их
    for (const roomId of socket.activeRooms) {
      try {
        // Проверяем, что комната ещё активна
        const roomResult = await pool.query(
          `SELECT id, status, organizer_id FROM match_rooms WHERE id = $1`,
          [roomId]
        )

        if (roomResult.rows.length === 0) continue

        const room = roomResult.rows[0]
        if (room.status === 'cancelled') continue

        // Даём 30 секунд на переподключение (обновление страницы)
        setTimeout(async () => {
          try {
            // Проверяем ещё раз — вдруг пользователь вернулся
            const checkUser = await pool.query(
              `SELECT * FROM match_participants 
               WHERE room_id = $1 AND user_id = $2`,
              [roomId, userId]
            )

            if (checkUser.rows.length === 0) return

            // Проверяем, онлайн ли пользователь сейчас
            if (onlineUsers.has(userId)) {
              console.log(`ℹ️  @${socket.userName} вернулся в комнату ${roomId}`)
              return
            }

            // Отменяем комнату
            await pool.query(
              `UPDATE match_rooms
               SET status = 'cancelled',
                   cancelled_by = $1,
                   cancelled_at = NOW()
               WHERE id = $2 AND status != 'cancelled'`,
              [userId, roomId]
            )

            console.log(`❌ Комната ${roomId} отменена — @${socket.userName} ушёл`)

            // Уведомляем остальных
            io.to(`match_room_${roomId}`).emit('match:cancelled', {
              roomId,
              cancelledByName: socket.userName,
              reason: 'disconnect',
            })
          } catch (err) {
            console.error('Ошибка обработки отключения:', err.message)
          }
        }, 30000) // 30 секунд
      } catch (err) {
        console.error('Ошибка при disconnect:', err.message)
      }
    }
  })
})

// Хелпер для отправки уведомления
function emitNotification(userId, data) {
  const socketId = onlineUsers.get(userId)
  if (socketId) {
    io.to(socketId).emit('notification', data)
  }
}

// ───────────────────────── MIDDLEWARE ─────────────────────────

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization
  if (!authHeader) return res.status(401).json({ error: 'Нет токена' })

  const token = authHeader.split(' ')[1]
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    req.user = decoded
    next()
  } catch (err) {
    return res.status(401).json({ error: 'Неверный токен' })
  }
}

// ───────────────────────── HELPERS ─────────────────────────

async function saveMovieToDb(movie) {
  if (!movie || !movie.kinopoiskId) return null

  try {
    const result = await pool.query(
      `INSERT INTO movies (
        kinopoisk_id, name_ru, name_en, name_original, year, type,
        poster_url, poster_url_preview, rating_kinopoisk, rating_imdb,
        description, film_length, slogan
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (kinopoisk_id) DO UPDATE SET
        name_ru = EXCLUDED.name_ru,
        name_en = EXCLUDED.name_en,
        name_original = EXCLUDED.name_original,
        year = EXCLUDED.year,
        type = EXCLUDED.type,
        poster_url = EXCLUDED.poster_url,
        poster_url_preview = EXCLUDED.poster_url_preview,
        rating_kinopoisk = EXCLUDED.rating_kinopoisk,
        rating_imdb = EXCLUDED.rating_imdb,
        description = EXCLUDED.description,
        film_length = EXCLUDED.film_length,
        slogan = EXCLUDED.slogan,
        updated_at = NOW()
      RETURNING *`,
      [
        movie.kinopoiskId,
        movie.nameRu || null,
        movie.nameEn || null,
        movie.nameOriginal || null,
        movie.year || null,
        movie.type || null,
        movie.posterUrl || null,
        movie.posterUrlPreview || null,
        movie.ratingKinopoisk || null,
        movie.ratingImdb || null,
        movie.description || null,
        movie.filmLength || null,
        movie.slogan || null,
      ]
    )
    return result.rows[0]
  } catch (err) {
    console.error('Ошибка сохранения фильма:', err)
    return null
  }
}

async function createNotification(userId, type, message, link = null) {
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, type, message, link)
       VALUES ($1, $2, $3, $4)`,
      [userId, type, message, link]
    )
    emitNotification(userId, { type, message, link })
  } catch (err) {
    console.error('Ошибка создания уведомления:', err.message)
  }
}

// ───────────────────────── AUTH ─────────────────────────

app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body
  try {
    const hash = await bcrypt.hash(password, 10)
    const result = await pool.query(
      'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email',
      [name, email, hash]
    )
    res.json(result.rows[0])
  } catch (err) {
    console.error(err)
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Email или ник уже заняты' })
    }
    res.status(500).json({ error: 'Ошибка регистрации' })
  }
})

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email])
    if (result.rows.length === 0)
      return res.status(400).json({ error: 'Пользователь не найден' })

    const user = result.rows[0]
    const match = await bcrypt.compare(password, user.password_hash)
    if (!match) return res.status(400).json({ error: 'Неверный пароль' })

    const token = jwt.sign(
      { id: user.id, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    )
    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email },
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка входа' })
  }
})

// ───────────────────────── MOVIES (статусы) ─────────────────────────

app.get('/api/movies/:movieId', authMiddleware, async (req, res) => {
  const { movieId } = req.params
  const userId = req.user.id

  try {
    const result = await pool.query(
      'SELECT status FROM user_movies WHERE user_id = $1 AND movie_id = $2',
      [userId, movieId]
    )
    if (result.rows.length === 0) {
      return res.json({ status: 'not_watched' })
    }
    res.json({ status: result.rows[0].status })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка получения статуса' })
  }
})

app.post('/api/movies/:movieId', authMiddleware, async (req, res) => {
  const { movieId } = req.params
  const { status } = req.body
  const userId = req.user.id

  if (status === 'not_watched') {
    try {
      await pool.query(
        'DELETE FROM user_movies WHERE user_id = $1 AND movie_id = $2',
        [userId, movieId]
      )
      return res.json({ status: 'not_watched' })
    } catch (err) {
      console.error(err)
      return res.status(500).json({ error: 'Ошибка удаления' })
    }
  }

  const allowed = ['want_to_watch', 'watched']
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: 'Неверный статус' })
  }

  try {
    const result = await pool.query(
      `INSERT INTO user_movies (user_id, movie_id, status)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, movie_id)
       DO UPDATE SET status = EXCLUDED.status
       RETURNING *`,
      [userId, movieId, status]
    )
    res.json(result.rows[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка сохранения статуса' })
  }
})

// ───────────────────────── FRIENDS ─────────────────────────

app.get('/api/users/search', authMiddleware, async (req, res) => {
  const { name } = req.query
  const userId = req.user.id

  if (!name) return res.status(400).json({ error: 'Введите ник' })

  try {
    const result = await pool.query(
      'SELECT id, name FROM users WHERE name = $1 AND id != $2',
      [name, userId]
    )
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' })
    }
    res.json(result.rows[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка поиска' })
  }
})

app.get('/api/friends', authMiddleware, async (req, res) => {
  const userId = req.user.id

  try {
    const friendsResult = await pool.query(
      `SELECT 
        u.id,
        u.name,
        f.id AS friendship_id,
        f.status
       FROM friendships f
       JOIN users u ON u.id = CASE 
         WHEN f.user_id_1 = $1 THEN f.user_id_2 
         ELSE f.user_id_1 
       END
       WHERE (f.user_id_1 = $1 OR f.user_id_2 = $1)
         AND f.status = 'accepted'`,
      [userId]
    )

    const requestsResult = await pool.query(
      `SELECT 
        u.id,
        u.name,
        f.id AS friendship_id,
        f.status
       FROM friendships f
       JOIN users u ON u.id = f.user_id_1
       WHERE f.user_id_2 = $1 AND f.status = 'pending'`,
      [userId]
    )

    res.json({
      friends: friendsResult.rows,
      requests: requestsResult.rows,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка загрузки друзей' })
  }
})

app.post('/api/friends', authMiddleware, async (req, res) => {
  const { friendId } = req.body
  const userId = req.user.id

  if (userId === friendId) {
    return res.status(400).json({ error: 'Нельзя добавить себя' })
  }

  try {
    const existing = await pool.query(
      `SELECT * FROM friendships 
       WHERE (user_id_1 = $1 AND user_id_2 = $2)
          OR (user_id_1 = $2 AND user_id_2 = $1)`,
      [userId, friendId]
    )

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Заявка уже существует' })
    }

    const result = await pool.query(
      `INSERT INTO friendships (user_id_1, user_id_2, status)
       VALUES ($1, $2, 'pending')
       RETURNING *`,
      [userId, friendId]
    )

    const senderResult = await pool.query(
      'SELECT name FROM users WHERE id = $1',
      [userId]
    )
    const senderName = senderResult.rows[0]?.name || 'Кто-то'

    await createNotification(
      friendId,
      'friend_request',
      `@${senderName} отправил вам заявку в друзья`,
      '/friends'
    )

    io.emit('friends:updated', { userIds: [userId, friendId] })

    res.json(result.rows[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка отправки заявки' })
  }
})

app.patch('/api/friends/:id', authMiddleware, async (req, res) => {
  const { id } = req.params
  const userId = req.user.id

  try {
    const result = await pool.query(
      `UPDATE friendships 
       SET status = 'accepted'
       WHERE id = $1 AND user_id_2 = $2
       RETURNING *`,
      [id, userId]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Заявка не найдена' })
    }

    const friendship = result.rows[0]

    const accepterResult = await pool.query(
      'SELECT name FROM users WHERE id = $1',
      [userId]
    )
    const accepterName = accepterResult.rows[0]?.name || 'Кто-то'

    await createNotification(
      friendship.user_id_1,
      'friend_accepted',
      `@${accepterName} принял вашу заявку в друзья`,
      '/friends'
    )

    io.emit('friends:updated', {
      userIds: [friendship.user_id_1, friendship.user_id_2],
    })

    res.json(friendship)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка принятия заявки' })
  }
})

app.delete('/api/friends/:id', authMiddleware, async (req, res) => {
  const { id } = req.params
  const userId = req.user.id

  try {
    const result = await pool.query(
      `DELETE FROM friendships 
       WHERE id = $1 AND (user_id_1 = $2 OR user_id_2 = $2)
       RETURNING *`,
      [id, userId]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Связь не найдена' })
    }

    const f = result.rows[0]
    io.emit('friends:updated', {
      userIds: [f.user_id_1, f.user_id_2],
    })

    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка удаления' })
  }
})

// ───────────────────────── NOTIFICATIONS ─────────────────────────

app.get('/api/notifications', authMiddleware, async (req, res) => {
  const userId = req.user.id

  try {
    const result = await pool.query(
      `SELECT id, type, message, link, read, created_at
       FROM notifications
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [userId]
    )

    const unreadCount = await pool.query(
      'SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND read = FALSE',
      [userId]
    )

    res.json({
      notifications: result.rows,
      unreadCount: parseInt(unreadCount.rows[0].count),
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка загрузки уведомлений' })
  }
})

app.patch('/api/notifications/:id/read', authMiddleware, async (req, res) => {
  const { id } = req.params
  const userId = req.user.id

  try {
    await pool.query(
      'UPDATE notifications SET read = TRUE WHERE id = $1 AND user_id = $2',
      [id, userId]
    )
    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка' })
  }
})

app.patch('/api/notifications/read-all', authMiddleware, async (req, res) => {
  const userId = req.user.id

  try {
    await pool.query(
      'UPDATE notifications SET read = TRUE WHERE user_id = $1 AND read = FALSE',
      [userId]
    )
    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка' })
  }
})

// ───────────────────────── PROFILE ─────────────────────────

app.get('/api/users/:id', authMiddleware, async (req, res) => {
  const { id } = req.params
  const currentUserId = req.user.id

  try {
    const userResult = await pool.query(
      'SELECT id, name, email, created_at FROM users WHERE id = $1',
      [id]
    )

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' })
    }

    const user = userResult.rows[0]

    const countsResult = await pool.query(
      `SELECT 
        COUNT(*) FILTER (WHERE status = 'watched') AS watched,
        COUNT(*) FILTER (WHERE status = 'want_to_watch') AS want_to_watch
       FROM user_movies
       WHERE user_id = $1`,
      [id]
    )

    const counts = countsResult.rows[0]

    const friendsCountResult = await pool.query(
      `SELECT COUNT(*) FROM friendships
       WHERE (user_id_1 = $1 OR user_id_2 = $1) AND status = 'accepted'`,
      [id]
    )

    let friendshipStatus = 'none'
    let friendshipId = null
    let isFriend = false

    if (currentUserId !== parseInt(id)) {
      const friendshipResult = await pool.query(
        `SELECT id, user_id_1, user_id_2, status
         FROM friendships
         WHERE (user_id_1 = $1 AND user_id_2 = $2)
            OR (user_id_1 = $2 AND user_id_2 = $1)
         LIMIT 1`,
        [currentUserId, id]
      )

      if (friendshipResult.rows.length > 0) {
        const f = friendshipResult.rows[0]
        friendshipId = f.id

        if (f.status === 'accepted') {
          friendshipStatus = 'accepted'
          isFriend = true
        } else if (f.status === 'pending') {
          if (f.user_id_1 === currentUserId) {
            friendshipStatus = 'pending_outgoing'
          } else {
            friendshipStatus = 'pending_incoming'
          }
        }
      }
    }

    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: currentUserId === parseInt(id) ? user.email : undefined,
        created_at: user.created_at,
      },
      stats: {
        watched: parseInt(counts.watched),
        want_to_watch: parseInt(counts.want_to_watch),
        not_watched: 0,
        friends: parseInt(friendsCountResult.rows[0].count),
      },
      isFriend,
      friendshipStatus,
      friendshipId,
      isOwn: currentUserId === parseInt(id),
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка загрузки профиля' })
  }
})

app.get('/api/users/:id/movies', authMiddleware, async (req, res) => {
  const { id } = req.params
  const { status } = req.query

  try {
    let query = `
      SELECT 
        mv.kinopoisk_id AS "kinopoiskId",
        mv.name_ru AS "nameRu",
        mv.name_en AS "nameEn",
        mv.name_original AS "nameOriginal",
        mv.year,
        mv.poster_url_preview AS "posterUrlPreview",
        um.status
      FROM user_movies um
      LEFT JOIN movies mv ON mv.kinopoisk_id = um.movie_id
      WHERE um.user_id = $1
    `
    const params = [id]

    if (status && status !== 'all') {
      query += ' AND um.status = $2'
      params.push(status)
    }

    query += ' ORDER BY um.id DESC'

    const result = await pool.query(query, params)
    res.json({ movies: result.rows })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка загрузки фильмов' })
  }
})

app.get('/api/users/:id/common', authMiddleware, async (req, res) => {
  const { id } = req.params
  const currentUserId = req.user.id

  if (currentUserId === parseInt(id)) {
    return res.status(400).json({ error: 'Нельзя сравнить с собой' })
  }

  try {
    const result = await pool.query(
      `SELECT 
        mv.kinopoisk_id AS "kinopoiskId",
        mv.name_ru AS "nameRu",
        mv.name_en AS "nameEn",
        mv.name_original AS "nameOriginal",
        mv.year,
        mv.poster_url_preview AS "posterUrlPreview",
        u1.status AS my_status,
        u2.status AS their_status
       FROM user_movies u1
       JOIN user_movies u2 ON u2.movie_id = u1.movie_id AND u2.user_id = $2
       LEFT JOIN movies mv ON mv.kinopoisk_id = u1.movie_id
       WHERE u1.user_id = $1
       ORDER BY mv.year DESC`,
      [currentUserId, id]
    )

    res.json({ movies: result.rows })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка загрузки общих фильмов' })
  }
})

// ───────────────────────── MATCH ─────────────────────────

app.post('/api/match/rooms', authMiddleware, async (req, res) => {
  const { friendIds, criterion } = req.body
  const organizerId = req.user.id

  if (!friendIds || friendIds.length === 0) {
    return res.status(400).json({ error: 'Выберите хотя бы одного друга' })
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const roomResult = await client.query(
      `INSERT INTO match_rooms (organizer_id, criterion, status, current_round)
       VALUES ($1, $2, 'waiting', 1)
       RETURNING *`,
      [organizerId, criterion]
    )
    const room = roomResult.rows[0]

    await client.query(
      `INSERT INTO match_participants (room_id, user_id, joined, responded)
       VALUES ($1, $2, TRUE, TRUE)`,
      [room.id, organizerId]
    )

    for (const friendId of friendIds) {
      await client.query(
        `INSERT INTO match_participants (room_id, user_id, joined, responded)
         VALUES ($1, $2, FALSE, FALSE)`,
        [room.id, friendId]
      )
    }

    await client.query('COMMIT')

    const organizerResult = await pool.query(
      'SELECT name FROM users WHERE id = $1',
      [organizerId]
    )
    const organizerName = organizerResult.rows[0]?.name || 'Кто-то'

    for (const friendId of friendIds) {
      await createNotification(
        friendId,
        'match_invite',
        `@${organizerName} приглашает вас подобрать фильм`,
        '/match'
      )
      const friendSocket = onlineUsers.get(friendId)
      if (friendSocket) {
        io.to(friendSocket).emit('match:invite', {
          roomId: room.id,
          organizerName,
        })
      }
    }

    res.json(room)
  } catch (err) {
    await client.query('ROLLBACK')
    console.error(err)
    res.status(500).json({ error: 'Ошибка создания комнаты' })
  } finally {
    client.release()
  }
})

app.get('/api/match/rooms', authMiddleware, async (req, res) => {
  const userId = req.user.id

  try {
    const invitationsResult = await pool.query(
      `SELECT 
        r.id AS room_id, r.criterion, r.status, r.created_at,
        u.name AS organizer_name, u.id AS organizer_id
       FROM match_rooms r
       JOIN match_participants p ON p.room_id = r.id
       JOIN users u ON u.id = r.organizer_id
       WHERE p.user_id = $1 
         AND p.responded = FALSE
         AND r.status = 'waiting'
       ORDER BY r.created_at DESC`,
      [userId]
    )

    const ownRoomsResult = await pool.query(
      `SELECT 
        r.id AS room_id, r.criterion, r.status, r.created_at,
        r.cancelled_by, u.name AS cancelled_by_name
       FROM match_rooms r
       LEFT JOIN users u ON u.id = r.cancelled_by
       WHERE r.organizer_id = $1 
         AND r.status IN ('waiting', 'cancelled')
       ORDER BY r.created_at DESC`,
      [userId]
    )

    res.json({
      invitations: invitationsResult.rows,
      ownRooms: ownRoomsResult.rows,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка загрузки комнат' })
  }
})

app.get('/api/match/rooms/:id/movies', authMiddleware, async (req, res) => {
  const { id } = req.params

  try {
    const roomResult = await pool.query(
      'SELECT current_round FROM match_rooms WHERE id = $1',
      [id]
    )
    if (roomResult.rows.length === 0) {
      return res.status(404).json({ error: 'Комната не найдена' })
    }
    const currentRound = roomResult.rows[0].current_round

    const result = await pool.query(
      `SELECT 
        m.movie_id AS "kinopoiskId",
        mv.name_ru AS "nameRu",
        mv.name_en AS "nameEn",
        mv.name_original AS "nameOriginal",
        mv.year,
        mv.poster_url_preview AS "posterUrlPreview"
       FROM match_movies m
       LEFT JOIN movies mv ON mv.kinopoisk_id = m.movie_id
       WHERE m.room_id = $1 AND m.round = $2`,
      [id, currentRound]
    )

    res.json({ movies: result.rows, round: currentRound })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка загрузки фильмов' })
  }
})

app.get('/api/match/rooms/:id', authMiddleware, async (req, res) => {
  const { id } = req.params

  try {
    const roomResult = await pool.query(
      `SELECT r.*, u.name AS organizer_name
       FROM match_rooms r
       JOIN users u ON u.id = r.organizer_id
       WHERE r.id = $1`,
      [id]
    )

    if (roomResult.rows.length === 0) {
      return res.status(404).json({ error: 'Комната не найдена' })
    }

    const participantsResult = await pool.query(
      `SELECT p.user_id AS id, u.name, p.joined, p.responded, p.declined,
              (p.user_id = r.organizer_id) AS is_organizer
       FROM match_participants p
       JOIN users u ON u.id = p.user_id
       JOIN match_rooms r ON r.id = p.room_id
       WHERE p.room_id = $1
       ORDER BY is_organizer DESC`,
      [id]
    )

    res.json({
      room: roomResult.rows[0],
      participants: participantsResult.rows,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка загрузки комнаты' })
  }
})

app.patch('/api/match/rooms/:id/respond', authMiddleware, async (req, res) => {
  const { id } = req.params
  const { accept } = req.body
  const userId = req.user.id

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const updateResult = await client.query(
      `UPDATE match_participants
       SET responded = TRUE, declined = $1, joined = $2
       WHERE room_id = $3 AND user_id = $4
       RETURNING *`,
      [!accept, accept, id, userId]
    )

    if (updateResult.rows.length === 0) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Участник не найден' })
    }

    let organizerId = null
    let declinerName = null

    if (!accept) {
      const roomResult = await client.query(
        'SELECT organizer_id FROM match_rooms WHERE id = $1',
        [id]
      )
      organizerId = roomResult.rows[0]?.organizer_id

      await client.query(
        `UPDATE match_rooms
         SET status = 'cancelled', cancelled_by = $1, cancelled_at = NOW()
         WHERE id = $2`,
        [userId, id]
      )

      const declinerResult = await client.query(
        'SELECT name FROM users WHERE id = $1',
        [userId]
      )
      declinerName = declinerResult.rows[0]?.name || 'Кто-то'
    }

    await client.query('COMMIT')

    if (!accept && organizerId && organizerId !== userId) {
      await createNotification(
        organizerId,
        'match_cancelled',
        `@${declinerName} отклонил приглашение в подбор`,
        '/match'
      )
    }

    io.to(`match_room_${id}`).emit('match:updated', { roomId: id })

    res.json({ success: true, accepted: accept })
  } catch (err) {
    await client.query('ROLLBACK')
    console.error(err)
    res.status(500).json({ error: 'Ошибка ответа' })
  } finally {
    client.release()
  }
})

app.post('/api/match/rooms/:id/round', authMiddleware, async (req, res) => {
  const { id } = req.params
  const userId = req.user.id

  try {
    const roomResult = await pool.query(
      'SELECT * FROM match_rooms WHERE id = $1',
      [id]
    )

    if (roomResult.rows.length === 0) {
      return res.status(404).json({ error: 'Комната не найдена' })
    }

    const room = roomResult.rows[0]

    if (room.organizer_id !== userId) {
      return res.status(403).json({ error: 'Только организатор может запустить' })
    }

    if (room.status === 'cancelled') {
      return res.status(400).json({ error: 'Комната закрыта' })
    }

    if (room.current_round === 1) {
      const notRespondedResult = await pool.query(
        'SELECT COUNT(*) FROM match_participants WHERE room_id = $1 AND responded = FALSE',
        [id]
      )
      if (parseInt(notRespondedResult.rows[0].count) > 0) {
        return res.status(400).json({ error: 'Не все приняли приглашение' })
      }
    }

    const participantsResult = await pool.query(
      'SELECT user_id FROM match_participants WHERE room_id = $1',
      [id]
    )
    const participantIds = participantsResult.rows.map((p) => p.user_id)

    let moviesQuery
    const params = []

    if (room.current_round === 1) {
      params.push(participantIds)

      switch (room.criterion) {
        case 'common_want':
          moviesQuery = `
            SELECT movie_id FROM user_movies
            WHERE user_id = ANY($1) AND status = 'want_to_watch'
            GROUP BY movie_id
            HAVING COUNT(DISTINCT user_id) = $2`
          params.push(participantIds.length)
          break
        case 'common_all':
          moviesQuery = `
            SELECT movie_id FROM user_movies
            WHERE user_id = ANY($1)
            GROUP BY movie_id
            HAVING COUNT(DISTINCT user_id) = $2`
          params.push(participantIds.length)
          break
        case 'all_want':
          moviesQuery = `
            SELECT DISTINCT movie_id FROM user_movies
            WHERE user_id = ANY($1) AND status = 'want_to_watch'`
          break
        case 'all_movies':
        default:
          moviesQuery = `
            SELECT DISTINCT movie_id FROM user_movies
            WHERE user_id = ANY($1)`
          break
      }
    } else {
      const prevRound = room.current_round - 1
      const prevResult = await pool.query(
        `SELECT movie_id FROM match_votes
         WHERE room_id = $1 AND round = $2 AND vote = 'yes'
         GROUP BY movie_id
         HAVING COUNT(DISTINCT user_id) = $3`,
        [id, prevRound, participantIds.length]
      )
      const approvedIds = prevResult.rows.map((r) => r.movie_id)

      if (approvedIds.length === 0) {
        return res.json({ movies: [], round: room.current_round })
      }

      for (const movieId of approvedIds) {
        await pool.query(
          `INSERT INTO match_movies (room_id, movie_id, round)
           VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [id, movieId, room.current_round]
        )
      }

      moviesQuery = `SELECT movie_id FROM match_movies WHERE room_id = $1 AND round = $2`
      params.push(id, room.current_round)
    }

    let movieIds = []

    if (room.current_round === 1) {
      const moviesResult = await pool.query(moviesQuery, params)
      movieIds = moviesResult.rows.map((r) => r.movie_id)

      if (movieIds.length === 0) {
        return res.json({ movies: [], round: 1 })
      }

      for (const movieId of movieIds) {
        await pool.query(
          `INSERT INTO match_movies (room_id, movie_id, round)
           VALUES ($1, $2, 1)
           ON CONFLICT DO NOTHING`,
          [id, movieId]
        )
      }
    }

    const moviesData = await pool.query(
      `SELECT 
        m.movie_id AS "kinopoiskId",
        mv.name_ru AS "nameRu",
        mv.name_en AS "nameEn",
        mv.name_original AS "nameOriginal",
        mv.year,
        mv.poster_url_preview AS "posterUrlPreview"
       FROM match_movies m
       LEFT JOIN movies mv ON mv.kinopoisk_id = m.movie_id
       WHERE m.room_id = $1 AND m.round = $2`,
      [id, room.current_round]
    )

    await pool.query(
      `UPDATE match_rooms SET status = 'voting' WHERE id = $1`,
      [id]
    )

    // Socket — всем участникам
    io.to(`match_room_${id}`).emit('match:round_started', {
      roomId: id,
      round: room.current_round,
    })

    res.json({ movies: moviesData.rows, round: room.current_round })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка генерации фильмов' })
  }
})

app.post('/api/match/rooms/:id/vote', authMiddleware, async (req, res) => {
  const { id } = req.params
  const { movieId, vote } = req.body
  const userId = req.user.id

  if (!['yes', 'no'].includes(vote)) {
    return res.status(400).json({ error: 'Неверный голос' })
  }

  try {
    const roomResult = await pool.query(
      'SELECT current_round FROM match_rooms WHERE id = $1',
      [id]
    )
    const currentRound = roomResult.rows[0]?.current_round || 1

    await pool.query(
      `INSERT INTO match_votes (room_id, movie_id, user_id, vote, round)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (room_id, movie_id, user_id, round)
       DO UPDATE SET vote = EXCLUDED.vote`,
      [id, movieId, userId, vote, currentRound]
    )

    // Socket — уведомить комнату
    io.to(`match_room_${id}`).emit('match:vote', {
      roomId: id,
      movieId,
      userId,
    })

    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка голосования' })
  }
})

app.get('/api/match/rooms/:id/votes/:movieId', authMiddleware, async (req, res) => {
  const { id, movieId } = req.params

  try {
    const roomResult = await pool.query(
      'SELECT current_round FROM match_rooms WHERE id = $1',
      [id]
    )
    const currentRound = roomResult.rows[0]?.current_round || 1

    const result = await pool.query(
      'SELECT COUNT(*) FROM match_participants WHERE room_id = $1',
      [id]
    )
    const totalParticipants = parseInt(result.rows[0].count)

    const votes = await pool.query(
      `SELECT COUNT(DISTINCT user_id) FROM match_votes 
       WHERE room_id = $1 AND movie_id = $2 AND round = $3`,
      [id, movieId, currentRound]
    )
    const votedCount = parseInt(votes.rows[0].count)

    res.json({
      allVoted: votedCount === totalParticipants,
      votedCount,
      totalParticipants,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка проверки голосов' })
  }
})

app.get('/api/match/rooms/:id/results', authMiddleware, async (req, res) => {
  const { id } = req.params

  try {
    const roomResult = await pool.query(
      'SELECT current_round FROM match_rooms WHERE id = $1',
      [id]
    )
    const currentRound = roomResult.rows[0]?.current_round || 1

    const participantsResult = await pool.query(
      'SELECT COUNT(*) FROM match_participants WHERE room_id = $1',
      [id]
    )
    const totalParticipants = parseInt(participantsResult.rows[0].count)

    const result = await pool.query(
      `SELECT 
        m.movie_id AS "kinopoiskId",
        mv.name_ru AS "nameRu",
        mv.name_en AS "nameEn",
        mv.name_original AS "nameOriginal",
        mv.year,
        mv.poster_url_preview AS "posterUrlPreview"
       FROM match_movies m
       LEFT JOIN match_votes v 
         ON v.room_id = m.room_id AND v.movie_id = m.movie_id AND v.round = $2
       LEFT JOIN movies mv ON mv.kinopoisk_id = m.movie_id
       WHERE m.room_id = $1 AND m.round = $2
       GROUP BY m.movie_id, mv.name_ru, mv.name_en, mv.name_original, mv.year, mv.poster_url_preview
       HAVING COUNT(CASE WHEN v.vote = 'yes' THEN 1 END) = $3`,
      [id, currentRound, totalParticipants]
    )

    res.json({
      approved: result.rows,
      round: currentRound,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка получения результатов' })
  }
})

app.post('/api/match/rooms/:id/next-round', authMiddleware, async (req, res) => {
  const { id } = req.params
  const userId = req.user.id

  try {
    const roomResult = await pool.query(
      'SELECT * FROM match_rooms WHERE id = $1',
      [id]
    )

    if (roomResult.rows.length === 0) {
      return res.status(404).json({ error: 'Комната не найдена' })
    }

    const room = roomResult.rows[0]

    if (room.organizer_id !== userId) {
      return res.status(403).json({ error: 'Только организатор' })
    }

    const prevRound = room.current_round
    const newRound = prevRound + 1

    const participantsResult = await pool.query(
      'SELECT user_id FROM match_participants WHERE room_id = $1',
      [id]
    )
    const participantIds = participantsResult.rows.map((p) => p.user_id)

    const approvedResult = await pool.query(
      `SELECT movie_id FROM match_votes
       WHERE room_id = $1 AND round = $2 AND vote = 'yes'
       GROUP BY movie_id
       HAVING COUNT(DISTINCT user_id) = $3`,
      [id, prevRound, participantIds.length]
    )
    const approvedIds = approvedResult.rows.map((r) => r.movie_id)

    if (approvedIds.length === 0) {
      return res.status(400).json({ error: 'Нет одобренных фильмов' })
    }

    for (const movieId of approvedIds) {
      await pool.query(
        `INSERT INTO match_movies (room_id, movie_id, round)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [id, movieId, newRound]
      )
    }

    await pool.query(
      `UPDATE match_rooms SET current_round = $1, status = 'voting' WHERE id = $2`,
      [newRound, id]
    )

    const moviesData = await pool.query(
      `SELECT 
        m.movie_id AS "kinopoiskId",
        mv.name_ru AS "nameRu",
        mv.name_en AS "nameEn",
        mv.name_original AS "nameOriginal",
        mv.year,
        mv.poster_url_preview AS "posterUrlPreview"
       FROM match_movies m
       LEFT JOIN movies mv ON mv.kinopoisk_id = m.movie_id
       WHERE m.room_id = $1 AND m.round = $2`,
      [id, newRound]
    )

    // Socket
    io.to(`match_room_${id}`).emit('match:round_started', {
      roomId: id,
      round: newRound,
    })

    res.json({
      success: true,
      round: newRound,
      movies: moviesData.rows,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка перехода' })
  }
})

app.patch('/api/match/rooms/:id/cancel', authMiddleware, async (req, res) => {
  const { id } = req.params
  const userId = req.user.id

  try {
    const participant = await pool.query(
      'SELECT * FROM match_participants WHERE room_id = $1 AND user_id = $2',
      [id, userId]
    )

    if (participant.rows.length === 0) {
      return res.status(403).json({ error: 'Вы не участник комнаты' })
    }

    const others = await pool.query(
      'SELECT user_id FROM match_participants WHERE room_id = $1 AND user_id != $2',
      [id, userId]
    )

    await pool.query(
      `UPDATE match_rooms
       SET status = 'cancelled', cancelled_by = $1, cancelled_at = NOW()
       WHERE id = $2`,
      [userId, id]
    )

    const cancellerResult = await pool.query(
      'SELECT name FROM users WHERE id = $1',
      [userId]
    )
    const cancellerName = cancellerResult.rows[0]?.name || 'Кто-то'

    for (const p of others.rows) {
      await createNotification(
        p.user_id,
        'match_cancelled',
        `@${cancellerName} отменил подбор фильмов`,
        '/match'
      )
    }

    // Socket
    io.to(`match_room_${id}`).emit('match:cancelled', {
      roomId: id,
      cancelledByName: cancellerName,
    })

    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка отмены' })
  }
})

// ───────────────────────── KINOPOISK PROXY ─────────────────────────

const KINOPOISK_BASE = 'https://kinopoiskapiunofficial.tech/api/v2.2/films/'
const KINOPOISK_SEARCH =
  'https://kinopoiskapiunofficial.tech/api/v2.1/films/search-by-keyword?keyword='

const kinopoiskHeaders = {
  'X-API-KEY': process.env.KINOPOISK_KEY,
  'Content-Type': 'application/json',
}

app.get('/api/kinopoisk/main', authMiddleware, async (req, res) => {
  const page = parseInt(req.query.page) || 1
  const limit = parseInt(req.query.limit) || 20
  const offset = (page - 1) * limit

  try {
    const countResult = await pool.query('SELECT COUNT(*) FROM main_movies')
    const total = parseInt(countResult.rows[0].count)

    const result = await pool.query(
      `SELECT 
        m.kinopoisk_id AS "kinopoiskId",
        m.name_ru AS "nameRu",
        m.name_en AS "nameEn",
        m.name_original AS "nameOriginal",
        m.year,
        m.type,
        m.poster_url AS "posterUrl",
        m.poster_url_preview AS "posterUrlPreview",
        m.rating_kinopoisk AS "ratingKinopoisk",
        m.rating_imdb AS "ratingImdb",
        m.description,
        m.film_length AS "filmLength",
        m.slogan
       FROM main_movies mm
       JOIN movies m ON m.id = mm.movie_id
       ORDER BY mm.position ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    )

    res.json({
      items: result.rows,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      hasMore: offset + result.rows.length < total,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка загрузки фильмов' })
  }
})

app.get('/api/kinopoisk/search', authMiddleware, async (req, res) => {
  const { keyword } = req.query
  if (!keyword) return res.status(400).json({ error: 'Нет ключевого слова' })

  try {
    const dbResult = await pool.query(
      `SELECT 
        kinopoisk_id AS "kinopoiskId",
        name_ru AS "nameRu",
        name_en AS "nameEn",
        name_original AS "nameOriginal",
        year, type,
        poster_url_preview AS "posterUrlPreview"
       FROM movies
       WHERE LOWER(name_ru) LIKE LOWER($1)
          OR LOWER(name_en) LIKE LOWER($1)
          OR LOWER(name_original) LIKE LOWER($1)
       LIMIT 20`,
      [`%${keyword}%`]
    )

    const response = await fetch(
      `${KINOPOISK_SEARCH}${encodeURIComponent(keyword)}`,
      { headers: kinopoiskHeaders }
    )
    const data = await response.json()
    const films = data.films || []

    for (const film of films) {
      await saveMovieToDb({
        kinopoiskId: film.filmId,
        nameRu: film.nameRu,
        nameEn: film.nameEn,
        nameOriginal: film.nameOriginal,
        year: film.year,
        type: film.type,
        posterUrl: film.posterUrl,
        posterUrlPreview: film.posterUrlPreview,
        ratingKinopoisk: film.rating,
        ratingImdb: film.ratingImdb,
        description: film.description,
        filmLength: film.filmLength,
        slogan: film.slogan,
      })
    }

    const combined = [...dbResult.rows]
    const dbIds = new Set(dbResult.rows.map((m) => m.kinopoiskId))

    for (const film of films) {
      if (!dbIds.has(film.filmId)) {
        combined.push({
          kinopoiskId: film.filmId,
          nameRu: film.nameRu,
          nameEn: film.nameEn,
          nameOriginal: film.nameOriginal,
          year: film.year,
          type: film.type,
          posterUrlPreview: film.posterUrlPreview,
        })
      }
    }

    res.json({ films: combined })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка поиска' })
  }
})

app.get('/api/kinopoisk/:id/facts', authMiddleware, async (req, res) => {
  const { id } = req.params

  try {
    const dbResult = await pool.query(
      'SELECT text FROM movie_facts WHERE movie_id = $1 ORDER BY id',
      [id]
    )

    if (dbResult.rows.length > 0) {
      return res.json({ items: dbResult.rows })
    }

    const response = await fetch(`${KINOPOISK_BASE}${id}/facts`, {
      headers: kinopoiskHeaders,
    })

    if (!response.ok) {
      return res.status(response.status).json({ items: [] })
    }

    const data = await response.json()
    const items = data.items || []

    for (const fact of items) {
      if (fact.text) {
        await pool.query(
          'INSERT INTO movie_facts (movie_id, text) VALUES ($1, $2)',
          [id, fact.text]
        )
      }
    }

    res.json({ items })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка загрузки фактов' })
  }
})

app.get('/api/kinopoisk/:id/relations', authMiddleware, async (req, res) => {
  const { id } = req.params

  try {
    const dbResult = await pool.query(
      `SELECT 
        related_movie_id AS "kinopoiskId",
        relation_type AS "relationType",
        name_ru AS "nameRu",
        name_en AS "nameEn",
        name_original AS "nameOriginal",
        year,
        poster_url AS "posterUrl",
        poster_url_preview AS "posterUrlPreview"
       FROM movie_relations
       WHERE movie_id = $1
       ORDER BY year ASC NULLS LAST`,
      [id]
    )

    if (dbResult.rows.length > 0) {
      return res.json({ items: dbResult.rows })
    }

    const response = await fetch(`${KINOPOISK_BASE}${id}/relations`, {
      headers: kinopoiskHeaders,
    })

    if (!response.ok) {
      return res.status(response.status).json({ items: [] })
    }

    const data = await response.json()
    const items = data.items || []

    for (const item of items) {
      if (item.kinopoiskId) {
        await pool.query(
          `INSERT INTO movie_relations (
            movie_id, related_movie_id, relation_type,
            name_ru, name_en, name_original, year,
            poster_url, poster_url_preview
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT DO NOTHING`,
          [
            id,
            item.kinopoiskId,
            item.relationType,
            item.nameRu || null,
            item.nameEn || null,
            item.nameOriginal || null,
            item.year || null,
            item.posterUrl || null,
            item.posterUrlPreview || null,
          ]
        )

        if (item.nameRu || item.nameEn) {
          await saveMovieToDb({
            kinopoiskId: item.kinopoiskId,
            nameRu: item.nameRu,
            nameEn: item.nameEn,
            nameOriginal: item.nameOriginal,
            year: item.year,
            posterUrl: item.posterUrl,
            posterUrlPreview: item.posterUrlPreview,
          })
        }
      }
    }

    res.json({ items })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка загрузки связей' })
  }
})

app.get('/api/kinopoisk/:id/similars', authMiddleware, async (req, res) => {
  const { id } = req.params

  try {
    const dbResult = await pool.query(
      `SELECT 
        related_movie_id AS "filmId",
        relation_type AS "relationType",
        name_ru AS "nameRu",
        name_en AS "nameEn",
        name_original AS "nameOriginal",
        year,
        poster_url AS "posterUrl",
        poster_url_preview AS "posterUrlPreview"
       FROM movie_relations
       WHERE movie_id = $1 AND relation_type = 'SIMILAR'
       ORDER BY year ASC NULLS LAST`,
      [id]
    )

    if (dbResult.rows.length > 0) {
      return res.json({ items: dbResult.rows })
    }

    const response = await fetch(`${KINOPOISK_BASE}${id}/similars`, {
      headers: kinopoiskHeaders,
    })

    if (!response.ok) {
      return res.status(response.status).json({ items: [] })
    }

    const data = await response.json()
    const items = data.items || []

    for (const item of items) {
      if (item.filmId) {
        await pool.query(
          `INSERT INTO movie_relations (
            movie_id, related_movie_id, relation_type,
            name_ru, name_en, name_original, year,
            poster_url, poster_url_preview
          ) VALUES ($1, $2, 'SIMILAR', $3, $4, $5, $6, $7, $8)
          ON CONFLICT DO NOTHING`,
          [
            id,
            item.filmId,
            item.nameRu || null,
            item.nameEn || null,
            item.nameOriginal || null,
            item.year || null,
            item.posterUrl || null,
            item.posterUrlPreview || null,
          ]
        )

        if (item.nameRu || item.nameEn) {
          await saveMovieToDb({
            kinopoiskId: item.filmId,
            nameRu: item.nameRu,
            nameEn: item.nameEn,
            nameOriginal: item.nameOriginal,
            year: item.year,
            posterUrl: item.posterUrl,
            posterUrlPreview: item.posterUrlPreview,
          })
        }
      }
    }

    res.json({ items })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка загрузки похожих' })
  }
})

app.get('/api/kinopoisk/:id', authMiddleware, async (req, res) => {
  const { id } = req.params

  try {
    const result = await pool.query(
      `SELECT 
        kinopoisk_id AS "kinopoiskId",
        name_ru AS "nameRu",
        name_en AS "nameEn",
        name_original AS "nameOriginal",
        year, type,
        poster_url AS "posterUrl",
        poster_url_preview AS "posterUrlPreview",
        rating_kinopoisk AS "ratingKinopoisk",
        rating_imdb AS "ratingImdb",
        description,
        film_length AS "filmLength",
        slogan
       FROM movies WHERE kinopoisk_id = $1`,
      [id]
    )

    if (result.rows.length === 0) {
      const response = await fetch(`${KINOPOISK_BASE}${id}`, {
        headers: kinopoiskHeaders,
      })
      if (!response.ok) {
        return res.status(response.status).json({ error: 'Фильм не найден' })
      }
      const movie = await response.json()
      await saveMovieToDb(movie)
      return res.json(movie)
    }

    const movie = result.rows[0]

    const genresResult = await pool.query(
      'SELECT genre FROM movie_genres WHERE movie_id = $1 ORDER BY id',
      [id]
    )

    const countriesResult = await pool.query(
      'SELECT country FROM movie_countries WHERE movie_id = $1 ORDER BY id',
      [id]
    )

    if (genresResult.rows.length === 0 || countriesResult.rows.length === 0) {
      try {
        const response = await fetch(`${KINOPOISK_BASE}${id}`, {
          headers: kinopoiskHeaders,
        })
        if (response.ok) {
          const apiMovie = await response.json()

          if (apiMovie.genres) {
            for (const g of apiMovie.genres) {
              await pool.query(
                `INSERT INTO movie_genres (movie_id, genre)
                 VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                [id, g.genre]
              )
            }
          }

          if (apiMovie.countries) {
            for (const c of apiMovie.countries) {
              await pool.query(
                `INSERT INTO movie_countries (movie_id, country)
                 VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                [id, c.country]
              )
            }
          }

          const newGenres = await pool.query(
            'SELECT genre FROM movie_genres WHERE movie_id = $1',
            [id]
          )
          const newCountries = await pool.query(
            'SELECT country FROM movie_countries WHERE movie_id = $1',
            [id]
          )

          movie.genres = newGenres.rows
          movie.countries = newCountries.rows
        }
      } catch (err) {
        console.error('Ошибка загрузки жанров/стран:', err.message)
        movie.genres = []
        movie.countries = []
      }
    } else {
      movie.genres = genresResult.rows
      movie.countries = countriesResult.rows
    }

    res.json(movie)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка загрузки фильма' })
  }
})

// ───────────────────────── BACKGROUND UPDATE ─────────────────────────

const {
  logUpdate,
  logSessionStart,
  logSessionEnd,
  logSuccess,
  logError,
  logWarning,
} = require('./logger')

const UPDATE_INTERVAL = 24 * 60 * 60 * 1000
const UPDATE_BATCH_SIZE = 50
const UPDATE_DELAY_MS = 300

async function updateOneMovie(kinopoiskId) {
  const currentResult = await pool.query(
    `SELECT 
      name_ru, name_en, name_original, year, type,
      poster_url, poster_url_preview, rating_kinopoisk, rating_imdb,
      description, film_length, slogan
     FROM movies WHERE kinopoisk_id = $1`,
    [kinopoiskId]
  )

  if (currentResult.rows.length === 0) {
    return { changed: [], error: 'not_in_db' }
  }

  const current = currentResult.rows[0]

  const res = await fetch(`${KINOPOISK_BASE}${kinopoiskId}`, {
    headers: kinopoiskHeaders,
  })

  if (!res.ok) {
    return { changed: [], error: `HTTP ${res.status}` }
  }

  const fresh = await res.json()

  const changed = []

  const fields = {
    name_ru: fresh.nameRu,
    name_en: fresh.nameEn,
    name_original: fresh.nameOriginal,
    year: fresh.year,
    type: fresh.type,
    poster_url: fresh.posterUrl,
    poster_url_preview: fresh.posterUrlPreview,
    rating_kinopoisk: fresh.ratingKinopoisk,
    rating_imdb: fresh.ratingImdb,
    description: fresh.description,
    film_length: fresh.filmLength,
    slogan: fresh.slogan,
  }

  for (const [key, newValue] of Object.entries(fields)) {
    const oldValue = current[key]
    const oldNorm = oldValue === null || oldValue === undefined ? null : oldValue
    const newNorm = newValue === null || newValue === undefined ? null : newValue

    if (typeof newNorm === 'number' && typeof oldNorm === 'number' && newNorm === oldNorm) continue
    if (typeof newNorm === 'string' && typeof oldNorm === 'string' && newNorm.trim() === oldNorm.trim()) continue
    if (newNorm === null && oldNorm !== null) continue
    if (oldNorm !== newNorm) {
      changed.push({ field: key, old: oldNorm, new: newNorm })
    }
  }

  const currentGenresResult = await pool.query(
    'SELECT genre FROM movie_genres WHERE movie_id = $1 ORDER BY genre',
    [kinopoiskId]
  )
  const currentGenres = currentGenresResult.rows.map((r) => r.genre).sort()

  const freshGenres = (fresh.genres || [])
    .map((g) => g.genre)
    .filter(Boolean)
    .sort()

  const genresChanged =
    currentGenres.length !== freshGenres.length ||
    currentGenres.some((g, i) => g !== freshGenres[i])

  if (genresChanged && freshGenres.length > 0) {
    changed.push({
      field: 'genres',
      old: currentGenres.join(', '),
      new: freshGenres.join(', '),
    })
  }

  const currentCountriesResult = await pool.query(
    'SELECT country FROM movie_countries WHERE movie_id = $1 ORDER BY country',
    [kinopoiskId]
  )
  const currentCountries = currentCountriesResult.rows.map((r) => r.country).sort()

  const freshCountries = (fresh.countries || [])
    .map((c) => c.country)
    .filter(Boolean)
    .sort()

  const countriesChanged =
    currentCountries.length !== freshCountries.length ||
    currentCountries.some((c, i) => c !== freshCountries[i])

  if (countriesChanged && freshCountries.length > 0) {
    changed.push({
      field: 'countries',
      old: currentCountries.join(', '),
      new: freshCountries.join(', '),
    })
  }

  if (changed.length > 0) {
    await pool.query(
      `UPDATE movies SET
        name_ru = COALESCE($2, name_ru),
        name_en = COALESCE($3, name_en),
        name_original = COALESCE($4, name_original),
        year = COALESCE($5, year),
        type = COALESCE($6, type),
        poster_url = COALESCE($7, poster_url),
        poster_url_preview = COALESCE($8, poster_url_preview),
        rating_kinopoisk = COALESCE($9, rating_kinopoisk),
        rating_imdb = COALESCE($10, rating_imdb),
        description = COALESCE($11, description),
        film_length = COALESCE($12, film_length),
        slogan = COALESCE($13, slogan),
        updated_at = NOW()
       WHERE kinopoisk_id = $1`,
      [
        kinopoiskId,
        fresh.nameRu || null,
        fresh.nameEn || null,
        fresh.nameOriginal || null,
        fresh.year || null,
        fresh.type || null,
        fresh.posterUrl || null,
        fresh.posterUrlPreview || null,
        fresh.ratingKinopoisk || null,
        fresh.ratingImdb || null,
        fresh.description || null,
        fresh.filmLength || null,
        fresh.slogan || null,
      ]
    )
  } else {
    await pool.query(
      `UPDATE movies SET updated_at = NOW() WHERE kinopoisk_id = $1`,
      [kinopoiskId]
    )
  }

  if (genresChanged && freshGenres.length > 0) {
    await pool.query('DELETE FROM movie_genres WHERE movie_id = $1', [kinopoiskId])
    for (const genre of freshGenres) {
      await pool.query(
        `INSERT INTO movie_genres (movie_id, genre) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [kinopoiskId, genre]
      )
    }
  }

  if (countriesChanged && freshCountries.length > 0) {
    await pool.query('DELETE FROM movie_countries WHERE movie_id = $1', [kinopoiskId])
    for (const country of freshCountries) {
      await pool.query(
        `INSERT INTO movie_countries (movie_id, country) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [kinopoiskId, country]
      )
    }
  }

  return { changed, error: null }
}

async function cleanupOldNotifications() {
  try {
    const result = await pool.query(
      `DELETE FROM notifications 
       WHERE created_at < NOW() - INTERVAL '90 days'`
    )
    if (result.rowCount > 0) {
      logUpdate(`🧹 Удалено старых уведомлений: ${result.rowCount}`)
    }
  } catch (err) {
    logError('cleanup-notifications', err.message)
  }
}

async function updateOldMovies() {
  logUpdate('Проверяю фильмы для обновления...')

  try {
    const result = await pool.query(
      `SELECT kinopoisk_id
       FROM movies
       ORDER BY COALESCE(updated_at, created_at) ASC
       LIMIT $1`,
      [UPDATE_BATCH_SIZE]
    )

    if (result.rows.length === 0) {
      logWarning('Нет фильмов для обновления')
      return
    }

    logSessionStart(result.rows.length)

    let success = 0
    let failed = 0
    let unchanged = 0
    let stopped = false

    for (const row of result.rows) {
      try {
        const { changed, error } = await updateOneMovie(row.kinopoisk_id)

        if (error === 'not_in_db') {
          logWarning(`Фильм ${row.kinopoisk_id} не найден в БД`)
          failed++
          continue
        }

        if (error && error.startsWith('HTTP')) {
          if (error === 'HTTP 402' || error === 'HTTP 429') {
            logWarning('Лимит API исчерпан — прерываю обновление')
            stopped = true
            break
          }
          logError(row.kinopoisk_id, error)
          failed++
          continue
        }

        if (error) {
          logError(row.kinopoisk_id, error)
          failed++
          continue
        }

        if (changed.length === 0) {
          unchanged++
          logUpdate(`  ○ ${row.kinopoisk_id} — без изменений`)
        } else {
          success++
          const changesText = changed
            .map((c) => `${c.field}: "${c.old}" → "${c.new}"`)
            .join(', ')
          logUpdate(`  ✓ ${row.kinopoisk_id} — обновлено: ${changesText}`)
        }
      } catch (err) {
        failed++
        logError(row.kinopoisk_id, err.message)
      }

      await new Promise((r) => setTimeout(r, UPDATE_DELAY_MS))
    }

    logUpdate('───────────────────────────────────────')
    logUpdate(`✅ Обновлено: ${success}`)
    logUpdate(`○  Без изменений: ${unchanged}`)
    logUpdate(`❌ Ошибок: ${failed}`)
    if (stopped) logUpdate('⚠️  Прервано из-за лимита API')
    logUpdate('🏁 ЗАВЕРШЕНО')
    logUpdate('═══════════════════════════════════════')
    logUpdate('')
  } catch (err) {
    logError('session', err.message)
  }

  await cleanupOldNotifications()
}

setTimeout(updateOldMovies, 10000)
setInterval(updateOldMovies, UPDATE_INTERVAL)

httpServer.listen(process.env.PORT, () => {
  console.log(`Сервер запущен на порту ${process.env.PORT}`)
})