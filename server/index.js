require('dotenv').config()
const multer = require('multer')
const upload = multer({ storage: multer.memoryStorage() })
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

  // Заменяем null на 'Отсутствует' ТОЛЬКО для текстовых полей
  // Для чисел оставляем null (или 0), чтобы не ломать тип данных
  const notEmptyText = (val) => (val === null || val === undefined ? 'Отсутствует' : val)
  const notEmptyNum = (val) => (val === null || val === undefined ? 0 : val)

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
        notEmptyText(movie.nameRu),
        notEmptyText(movie.nameEn),
        notEmptyText(movie.nameOriginal),
        notEmptyNum(movie.year),           // <-- Число
        notEmptyText(movie.type),          // <-- Тип это строка (FILM, TV_SERIES)
        notEmptyText(movie.posterUrl),
        notEmptyText(movie.posterUrlPreview),
        notEmptyNum(movie.ratingKinopoisk), // <-- Число
        notEmptyNum(movie.ratingImdb),      // <-- Число
        notEmptyText(movie.description),
        notEmptyNum(movie.filmLength),      // <-- Число
        notEmptyText(movie.slogan),
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
      { expiresIn: '30d' }
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

app.post('/api/import/upload', authMiddleware, upload.single('file'), async (req, res) => {
  const userId = req.user.id
  const file = req.file
  const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN
  const CHAT_ID = process.env.TELEGRAM_CHAT_ID

  if (!file) {
    return res.status(400).json({ error: 'Файл не загружен' })
  }

  // 1. Проверка расширения
  const ext = file.originalname.split('.').pop().toLowerCase()
  if (ext !== 'xlsx') {
    return res.status(400).json({ error: 'Поддерживается только формат .xlsx' })
  }

  // 2. Проверка магических байтов (реальный тип файла)
  // XLSX — это ZIP-архив. Он всегда начинается с байтов 50 4B 03 04 (PK..)
  const magicBytes = file.buffer.slice(0, 4).toString('hex').toUpperCase()
  if (magicBytes !== '504B0304') {
    return res.status(400).json({ error: 'Файл поврежден или не является настоящим .xlsx' })
  }

  if (!TELEGRAM_TOKEN || !CHAT_ID) {
    return res.status(500).json({ error: 'Telegram не настроен на сервере' })
  }

  try {
    const formData = new FormData()
    formData.append('chat_id', CHAT_ID)
    formData.append('caption', `Новый импорт фильмов от пользователя #${userId}`)

    // Используем Blob для правильной отправки бинарных данных
    const blob = new Blob([file.buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    formData.append('document', blob, file.originalname)

    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendDocument`, {
      method: 'POST',
      body: formData,
    })

    const data = await response.json()

    if (!data.ok) {
      console.error('Ошибка Telegram:', data.description)
      throw new Error(data.description || 'Ошибка Telegram API')
    }

    res.json({ success: true, message: 'Файл отправлен в Telegram' })
  } catch (err) {
    console.error('Ошибка импорта:', err.message)
    res.status(500).json({ error: 'Не удалось отправить файл. Попробуйте позже.' })
  }
})

// ───────────────────────── MOVIES (статусы) ─────────────────────────
app.get('/api/kinopoisk/:id/watched-episodes', authMiddleware, async (req, res) => {
  const { id } = req.params
  const userId = req.user.id
  try {
    const result = await pool.query(
      'SELECT season_number, episode_number FROM user_episodes WHERE user_id = $1 AND movie_id = $2',
      [userId, id]
    )
    res.json({ episodes: result.rows })
  } catch (err) {
    res.status(500).json({ error: 'Ошибка' })
  }
})

app.post('/api/episodes/toggle', authMiddleware, async (req, res) => {
  const { movieId, seasonNumber, episodeNumber, watched } = req.body
  const userId = req.user.id

  try {
    if (watched) {
      await pool.query(
        `INSERT INTO user_episodes (user_id, movie_id, season_number, episode_number)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [userId, movieId, seasonNumber, episodeNumber]
      )
    } else {
      await pool.query(
        `DELETE FROM user_episodes 
         WHERE user_id = $1 AND movie_id = $2 AND season_number = $3 AND episode_number = $4`,
        [userId, movieId, seasonNumber, episodeNumber]
      )
    }

    // Считаем вышедшие и просмотренные серии
    const allEpisodes = await pool.query(
      `SELECT season_number, episode_number FROM seasons 
       WHERE movie_id = $1 AND (release_date <= NOW() OR release_date IS NULL)`,
      [movieId]
    )

    const watchedEpisodes = await pool.query(
      `SELECT season_number, episode_number FROM user_episodes 
       WHERE user_id = $1 AND movie_id = $2`,
      [userId, movieId]
    )

    const totalAired = allEpisodes.rows.length
    const totalWatched = watchedEpisodes.rows.length

    // Если все серии просмотрены — ставим watched, иначе watching
    if (totalAired > 0 && totalWatched >= totalAired) {
      await pool.query(
        `INSERT INTO user_movies (user_id, movie_id, status) 
         VALUES ($1, $2, 'watched') 
         ON CONFLICT (user_id, movie_id) DO UPDATE SET status = 'watched'`,
        [userId, movieId]
      )
    } else {
      await pool.query(
        `INSERT INTO user_movies (user_id, movie_id, status) 
         VALUES ($1, $2, 'watching') 
         ON CONFLICT (user_id, movie_id) DO UPDATE SET status = 'watching'`,
        [userId, movieId]
      )
    }

    res.json({ success: true, newStatus: totalAired > 0 && totalWatched >= totalAired ? 'watched' : 'watching' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка отметки серии' })
  }
})

app.post('/api/episodes/bulk-toggle', authMiddleware, async (req, res) => {
  const { movieId, seasonNumber, episodes, watched } = req.body
  const userId = req.user.id

  if (!episodes || !Array.isArray(episodes)) {
    return res.status(400).json({ error: 'Неверный формат данных' })
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    for (const ep of episodes) {
      if (watched) {
        await client.query(
          `INSERT INTO user_episodes (user_id, movie_id, season_number, episode_number)
           VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
          [userId, movieId, seasonNumber, ep.episode_number]
        )
      } else {
        await client.query(
          `DELETE FROM user_episodes 
           WHERE user_id = $1 AND movie_id = $2 AND season_number = $3 AND episode_number = $4`,
          [userId, movieId, seasonNumber, ep.episode_number]
        )
      }
    }

    // Пересчитываем статус всего сериала
    const allAiredEpisodes = await client.query(
      `SELECT season_number, episode_number FROM seasons 
       WHERE movie_id = $1 AND (release_date <= NOW() OR release_date IS NULL)`,
      [movieId]
    )

    const watchedEpisodes = await client.query(
      `SELECT season_number, episode_number FROM user_episodes 
       WHERE user_id = $1 AND movie_id = $2`,
      [userId, movieId]
    )

    const totalAired = allAiredEpisodes.rows.length
    const totalWatched = watchedEpisodes.rows.length

    let newStatus = 'watching'
    if (totalAired > 0 && totalWatched >= totalAired) {
      newStatus = 'watched'
    } else if (totalWatched === 0) {
      // Если ничего не просмотрено, удаляем статус (или ставим not_watched)
      await client.query(
        'DELETE FROM user_movies WHERE user_id = $1 AND movie_id = $2',
        [userId, movieId]
      )
      await client.query('COMMIT')
      return res.json({ success: true, newStatus: 'not_watched' })
    }

    await client.query(
      `INSERT INTO user_movies (user_id, movie_id, status) 
       VALUES ($1, $2, $3) 
       ON CONFLICT (user_id, movie_id) DO UPDATE SET status = EXCLUDED.status`,
      [userId, movieId, newStatus]
    )

    await client.query('COMMIT')
    res.json({ success: true, newStatus })
  } catch (err) {
    await client.query('ROLLBACK')
    console.error(err)
    res.status(500).json({ error: 'Ошибка массовой отметки' })
  } finally {
    client.release()
  }
})

app.post('/api/movies/bulk-statuses', authMiddleware, async (req, res) => {
  const { movieIds } = req.body
  const userId = req.user.id

  if (!movieIds || !Array.isArray(movieIds) || movieIds.length === 0) {
    return res.json({ statuses: {} })
  }

  try {
    const result = await pool.query(
      'SELECT movie_id, status FROM user_movies WHERE user_id = $1 AND movie_id = ANY($2)',
      [userId, movieIds]
    )

    // Превращаем массив [{movie_id, status}] в объект { movie_id: status }
    const statuses = {}
    result.rows.forEach((row) => {
      statuses[row.movie_id] = row.status
    })

    res.json({ statuses })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка получения статусов' })
  }
})

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
      // Проверяем, есть ли отмеченные серии
      const watchedResult = await pool.query(
        'SELECT COUNT(*) FROM user_episodes WHERE user_id = $1 AND movie_id = $2',
        [userId, movieId]
      )

      if (parseInt(watchedResult.rows[0].count) > 0) {
        return res.status(400).json({
          error: 'Нельзя сбросить статус, пока отмечены серии. Сначала снимите отметки.'
        })
      }

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

  const allowed = ['want_to_watch', 'watched', 'watching']
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: 'Неверный статус' })
  }

  // Если это сериал, нельзя ставить 'watched' напрямую
  if (status === 'watched') {
    const movieType = await pool.query('SELECT type FROM movies WHERE kinopoisk_id = $1', [movieId])
    if (movieType.rows[0]?.type === 'TV_SERIES' || movieType.rows[0]?.type === 'MINI_SERIES') {
      return res.status(400).json({ error: 'Сериалы нельзя отметить как просмотренные напрямую. Отмечайте серии.' })
    }
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
// ───────────────────────── MY SERIES ─────────────────────────

app.get('/api/users/me/watching', authMiddleware, async (req, res) => {
  const userId = req.user.id

  try {
    const moviesResult = await pool.query(
      `SELECT 
        m.kinopoisk_id AS "kinopoiskId",
        m.name_ru AS "nameRu",
        m.name_en AS "nameEn",
        m.poster_url_preview AS "posterUrlPreview",
        m.year
       FROM user_movies um
       JOIN movies m ON m.kinopoisk_id = um.movie_id
       WHERE um.user_id = $1 AND um.status = 'watching'
       ORDER BY um.id DESC`,
      [userId]
    )

    const series = []

    for (const movie of moviesResult.rows) {
      const allAiredEpisodes = await pool.query(
        `SELECT season_number, episode_number, release_date
         FROM seasons 
         WHERE movie_id = $1 AND (release_date <= NOW() OR release_date IS NULL)
         ORDER BY season_number ASC, episode_number ASC`,
        [movie.kinopoiskId]
      )

      const watchedEpisodes = await pool.query(
        `SELECT season_number, episode_number 
         FROM user_episodes 
         WHERE user_id = $1 AND movie_id = $2`,
        [userId, movie.kinopoiskId]
      )

      const watchedSet = new Set(
        watchedEpisodes.rows.map((e) => `${e.season_number}-${e.episode_number}`)
      )

      let nextEpisode = null
      for (const ep of allAiredEpisodes.rows) {
        const key = `${ep.season_number}-${ep.episode_number}`
        if (!watchedSet.has(key)) {
          nextEpisode = ep
          break
        }
      }

      let nextEpisodeName = null
      let nextEpisodeDate = null
      if (nextEpisode) {
        const epDetails = await pool.query(
          'SELECT name_ru, release_date FROM seasons WHERE movie_id = $1 AND season_number = $2 AND episode_number = $3',
          [movie.kinopoiskId, nextEpisode.season_number, nextEpisode.episode_number]
        )
        nextEpisodeName = epDetails.rows[0]?.name_ru
        nextEpisodeDate = nextEpisode.release_date
      }

      series.push({
        ...movie,
        nextSeason: nextEpisode ? nextEpisode.season_number : null,
        nextEpisode: nextEpisode ? nextEpisode.episode_number : null,
        nextEpisodeName: nextEpisodeName,
        nextEpisodeDate: nextEpisodeDate, // <-- Добавили дату выхода
        remaining: allAiredEpisodes.rows.length - watchedSet.size,
        totalAired: allAiredEpisodes.rows.length,
        watchedCount: watchedSet.size,
      })
    }

    res.json({ series })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка загрузки сериалов' })
  }
})

app.get('/api/users/me/watchlist-series', authMiddleware, async (req, res) => {
  const userId = req.user.id

  try {
    const result = await pool.query(
      `SELECT 
        m.kinopoisk_id AS "kinopoiskId",
        m.name_ru AS "nameRu",
        m.name_en AS "nameEn",
        m.name_original AS "nameOriginal",
        m.year,
        m.type,
        m.poster_url_preview AS "posterUrlPreview",
        m.rating_kinopoisk AS "ratingKinopoisk",
        m.rating_imdb AS "ratingImdb",
        m.film_length AS "filmLength",
        (SELECT COUNT(*) FROM seasons WHERE movie_id = m.kinopoisk_id AND (release_date <= NOW() OR release_date IS NULL)) AS "episodesCount"
       FROM user_movies um
       JOIN movies m ON m.kinopoisk_id = um.movie_id
       WHERE um.user_id = $1 
         AND um.status = 'want_to_watch'
         AND m.type IN ('TV_SERIES', 'MINI_SERIES', 'TV_SHOW')
       ORDER BY um.id DESC`,
      [userId]
    )

    const series = []

    for (const row of result.rows) {
      // Считаем, сколько серий просмотрено пользователем
      const watchedResult = await pool.query(
        'SELECT COUNT(*) FROM user_episodes WHERE user_id = $1 AND movie_id = $2',
        [userId, row.kinopoiskId]
      )
      const watchedCount = parseInt(watchedResult.rows[0].count)
      const totalAired = parseInt(row.episodesCount) || 0

      // Вычисляем остаток
      // Если что-то просмотрено — остаток = всего вышедших - просмотрено
      // Если ничего не просмотрено — остаток = всего вышедших
      const remaining = watchedCount > 0 ? Math.max(0, totalAired - watchedCount) : totalAired

      series.push({
        ...row,
        episodesCount: totalAired,
        watchedCount,
        remaining
      })
    }

    res.json({ series })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка загрузки списка сериалов' })
  }
})
app.get('/api/users/me/watchlist', authMiddleware, async (req, res) => {
  const userId = req.user.id

  try {
    const result = await pool.query(
      `SELECT 
        m.kinopoisk_id AS "kinopoiskId",
        m.name_ru AS "nameRu",
        m.name_en AS "nameEn",
        m.name_original AS "nameOriginal",
        m.year,
        m.type,
        m.poster_url_preview AS "posterUrlPreview",
        m.rating_kinopoisk AS "ratingKinopoisk",
        m.rating_imdb AS "ratingImdb",
        m.film_length AS "filmLength",
        m.description
       FROM user_movies um
       JOIN movies m ON m.kinopoisk_id = um.movie_id
       WHERE um.user_id = $1 
         AND um.status = 'want_to_watch'
         AND m.type IN ('FILM', 'VIDEO')
       ORDER BY um.id DESC`,
      [userId]
    )

    res.json({ movies: result.rows })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка загрузки списка фильмов' })
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
  const { id } = req.params // ID пользователя, чей профиль смотрим
  const currentUserId = req.user.id // ID того, кто смотрит
  const { status } = req.query // Фильтр по статусу (если выбран)

  try {
    // Формируем базовый запрос
    let query = `
      SELECT 
        mv.kinopoisk_id AS "kinopoiskId",
        mv.name_ru AS "nameRu",
        mv.name_en AS "nameEn",
        mv.name_original AS "nameOriginal",
        mv.year,
        mv.poster_url_preview AS "posterUrlPreview",
        um_owner.status AS status, -- Статус владельца профиля (для фильтра)
        um_me.status AS my_status  -- ТВОЙ статус (для цвета)
      FROM user_movies um_owner
      LEFT JOIN movies mv ON mv.kinopoisk_id = um_owner.movie_id
      LEFT JOIN user_movies um_me ON um_me.movie_id = um_owner.movie_id AND um_me.user_id = $2
      WHERE um_owner.user_id = $1
    `
    const params = [id, currentUserId]

    // Если выбран фильтр по статусу (например, "Посмотрел"), фильтруем по статусу ВЛАДЕЛЬЦА
    if (status && status !== 'all') {
      query += ' AND um_owner.status = $3'
      params.push(status)
    }

    query += ' ORDER BY um_owner.id DESC'

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
         AND u1.status = 'want_to_watch'
         AND u2.status = 'want_to_watch'
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
  const category = req.query.category || 'MARVEL'
  const typeFilter = req.query.type || 'ALL'
  const userId = req.user.id

  try {
    // Если это наша кастомная категория MARVEL
    if (category === 'MARVEL') {
      const limit = parseInt(req.query.limit) || 20
      const offset = (page - 1) * limit

      let countQuery = 'SELECT COUNT(*) FROM main_movies mm JOIN movies m ON m.id = mm.movie_id'
      let dataQuery = `
        SELECT 
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
          m.slogan,
          COALESCE(um.status, 'not_watched') AS status
         FROM main_movies mm
         JOIN movies m ON m.id = mm.movie_id
         LEFT JOIN user_movies um ON um.movie_id = m.kinopoisk_id AND um.user_id = $3
      `
      const params = [limit, offset, userId]
      let countParams = []

      // Добавляем фильтр по типу, если выбран не "ALL"
      if (typeFilter !== 'ALL') {
        dataQuery += ` WHERE m.type = $4`
        countQuery += ` WHERE m.type = $1`
        params.push(typeFilter)
        countParams.push(typeFilter)
      }

      dataQuery += ` ORDER BY mm.position ASC LIMIT $1 OFFSET $2`

      const countResult = await pool.query(countQuery, countParams)
      const total = parseInt(countResult.rows[0].count)

      const result = await pool.query(dataQuery, params)

      return res.json({
        items: result.rows,
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasMore: offset + result.rows.length < total,
      })
    }

    // Для API-категорий (TOP_250 и т.д.)
    // В API Кинопоиска фильтр по типу пока не поддерживается в этом эндпоинте, 
    // поэтому мы загружаем страницу и фильтруем на клиенте (см. фронтенд)
    const response = await fetch(
      `https://kinopoiskapiunofficial.tech/api/v2.2/films/collections?type=${category}&page=${page}`,
      { headers: kinopoiskHeaders }
    )

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Ошибка загрузки категории' })
    }

    const data = await response.json()
    const films = data.items || []

    // Сохраняем фильмы в базу
    const filmIds = []
    for (const film of films) {
      await saveMovieToDb({
        kinopoiskId: film.kinopoiskId,
        nameRu: film.nameRu,
        nameEn: film.nameEn,
        nameOriginal: film.nameOriginal,
        year: film.year,
        type: film.type,
        posterUrl: film.posterUrl,
        posterUrlPreview: film.posterUrlPreview,
        ratingKinopoisk: film.ratingKinopoisk,
        ratingImdb: film.ratingImdb,
        description: film.description,
        filmLength: film.filmLength,
        slogan: film.slogan,
      })
      filmIds.push(film.kinopoiskId)
    }

    // Получаем статусы пользователя
    const statuses = {}
    if (filmIds.length > 0) {
      const statusResult = await pool.query(
        'SELECT movie_id, status FROM user_movies WHERE user_id = $1 AND movie_id = ANY($2)',
        [userId, filmIds]
      )
      statusResult.rows.forEach((row) => {
        statuses[row.movie_id] = row.status
      })
    }

    const items = films.map((film) => ({
      ...film,
      kinopoisId: film.kinopoiskId,
      status: statuses[film.kinopoiskId] || 'not_watched',
    }))

    res.json({
      items,
      page,
      totalPages: data.totalPages || 1,
      hasMore: page < (data.totalPages || 1),
      total: data.total || 0,
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

// Получение серий сериала
app.get('/api/kinopoisk/:id/seasons', authMiddleware, async (req, res) => {
  const { id } = req.params
  const KINOPOISK_DEV_TOKEN = process.env.KINOPOISK_DEV_TOKEN

  if (!KINOPOISK_DEV_TOKEN) {
    return res.status(500).json({ error: 'Токен kinopoisk.dev не настроен' })
  }

  try {
    // Ищем в базе (если уже кэшировали — отдаем)
    const dbResult = await pool.query(
      'SELECT season_number, episode_number, name_ru, release_date FROM seasons WHERE movie_id = $1 ORDER BY season_number, episode_number',
      [id]
    )

    if (dbResult.rows.length > 0) {
      return res.json({ episodes: dbResult.rows })
    }

    // Идем в kinopoisk.dev
    // Документация: эндпоинт /v1.4/season, поиск по movieId
    const url = `https://api.kinopoisk.dev/v1.4/season?movieId=${id}&limit=250`

    const response = await fetch(url, {
      headers: {
        'X-API-KEY': KINOPOISK_DEV_TOKEN,
        'Content-Type': 'application/json',
      },
    })

    if (!response.ok) {
      console.error('Ошибка kinopoisk.dev:', response.status)
      return res.status(response.status).json({ error: 'Не удалось загрузить сезоны с kinopoisk.dev' })
    }

    const data = await response.json()

    // Структура ответа kinopoisk.dev: { docs: [ { number: 1, episodes: [ { episodeNumber, name, airDate } ] } ] }
    const allEpisodes = []

    for (const season of data.docs || []) {
      for (const ep of season.episodes || []) {
        allEpisodes.push({
          season_number: season.number,
          // Пробуем разные варианты, чтобы точно поймать номер серии
          episode_number: ep.episodeNumber || ep.number || ep.episode,
          name_ru: ep.name || ep.nameRu,
          release_date: ep.airDate || ep.releaseDate,
        })
      }
    }

    // Сохраняем в базу
    for (const ep of allEpisodes) {
      await pool.query(
        `INSERT INTO seasons (movie_id, season_number, episode_number, name_ru, release_date)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (movie_id, season_number, episode_number) 
         DO UPDATE SET 
           name_ru = COALESCE(EXCLUDED.name_ru, seasons.name_ru),
           release_date = COALESCE(EXCLUDED.release_date, seasons.release_date)`,
        [id, ep.season_number, ep.episode_number, ep.name_ru, ep.release_date]
      )
    }

    res.json({ episodes: allEpisodes })
  } catch (err) {
    console.error('Ошибка загрузки сезонов:', err)
    res.status(500).json({ error: 'Ошибка загрузки сезонов' })
  }
})

app.get('/api/kinopoisk/:id', authMiddleware, async (req, res) => {
  const { id } = req.params

  try {
    // 1. Пытаемся достать фильм из базы
    let result = await pool.query(
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

    // 2. Если фильма нет вообще — идем в API
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

    // 3. Если фильм есть, но в каких-то полях есть NULL — обновляем данные
    const row = result.rows[0]
    const hasNulls = Object.values(row).some((val) => val === null)

    if (hasNulls) {
      console.log(`🔄 Найдены NULL в данных для фильма ${id}. Запускаю обновление...`)
      await updateOneMovie(id)

      // Перечитываем обновленные данные из базы
      result = await pool.query(
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
    }

    // 4. Формируем ответ
    const movie = result.rows[0]

    // 5. Загружаем жанры и страны
    const genresResult = await pool.query(
      'SELECT genre FROM movie_genres WHERE movie_id = $1 ORDER BY id',
      [id]
    )

    const countriesResult = await pool.query(
      'SELECT country FROM movie_countries WHERE movie_id = $1 ORDER BY id',
      [id]
    )

    // 6. Если жанров или стран нет — идем в API за ними
    if (genresResult.rows.length === 0 || countriesResult.rows.length === 0) {
      try {
        const response = await fetch(`${KINOPOISK_BASE}${id}`, {
          headers: kinopoiskHeaders,
        })
        if (response.ok) {
          const apiMovie = await response.json()

          // Сохраняем жанры
          if (apiMovie.genres) {
            for (const g of apiMovie.genres) {
              await pool.query(
                `INSERT INTO movie_genres (movie_id, genre)
                 VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                [id, g.genre]
              )
            }
          }

          // Сохраняем страны
          if (apiMovie.countries) {
            for (const c of apiMovie.countries) {
              await pool.query(
                `INSERT INTO movie_countries (movie_id, country)
                 VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                [id, c.country]
              )
            }
          }

          // Перечитываем жанры и страны из базы
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

const UPDATE_BATCH_SIZE = 100
const UPDATE_DELAY_MS = 300

// Поля, которые обновляем из API → колонки в БД
const FIELD_MAP = {
  name_ru: 'nameRu',
  name_en: 'nameEn',
  name_original: 'nameOriginal',
  year: 'year',
  type: 'type',
  poster_url: 'posterUrl',
  poster_url_preview: 'posterUrlPreview',
  rating_kinopoisk: 'ratingKinopoisk',
  rating_imdb: 'ratingImdb',
  description: 'description',
  film_length: 'filmLength',
  slogan: 'slogan',
}

// Числовые поля — сравниваем как числа, даже если из PG пришла строка
const NUMERIC_FIELDS = new Set([
  'year',
  'rating_kinopoisk',
  'rating_imdb',
  'film_length',
])

function normalizeForCompare(value, field) {
  if (value === null || value === undefined) return null

  if (typeof value === 'number') {
    return Number.isNaN(value) ? null : value
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '' || trimmed === 'null') return null

    // Для числовых полей и для строк, которые целиком являются числом
    if (NUMERIC_FIELDS.has(field) || /^-?\d+(\.\d+)?$/.test(trimmed)) {
      const asNum = Number(trimmed)
      if (!Number.isNaN(asNum)) return asNum
    }

    return trimmed
  }

  return value
}

async function updateSeasonsForMovie(kinopoiskId) {
  const KINOPOISK_DEV_TOKEN = process.env.KINOPOISK_DEV_TOKEN
  if (!KINOPOISK_DEV_TOKEN) return { changed: 0, error: 'no_token' }

  try {
    const url = `https://api.kinopoisk.dev/v1.4/season?movieId=${kinopoiskId}&limit=250`
    const response = await fetch(url, {
      headers: {
        'X-API-KEY': KINOPOISK_DEV_TOKEN,
        'Content-Type': 'application/json',
      },
    })

    if (!response.ok) {
      return { changed: 0, error: `HTTP ${response.status}` }
    }

    const data = await response.json()
    const allEpisodes = []

    for (const season of data.docs || []) {
      for (const ep of season.episodes || []) {
        allEpisodes.push({
          season_number: season.number,
          episode_number: ep.episodeNumber || ep.number || ep.episode,
          name_ru: ep.name || ep.nameRu,
          release_date: ep.airDate || ep.releaseDate,
        })
      }
    }

    let changedCount = 0

    for (const ep of allEpisodes) {
      // Проверяем, изменилось ли что-то
      const existing = await pool.query(
        'SELECT name_ru, release_date FROM seasons WHERE movie_id = $1 AND season_number = $2 AND episode_number = $3',
        [kinopoiskId, ep.season_number, ep.episode_number]
      )

      if (existing.rows.length > 0) {
        const oldEp = existing.rows[0]
        const oldDate = oldEp.release_date ? new Date(oldEp.release_date).toISOString().split('T')[0] : null
        const newDate = ep.release_date ? new Date(ep.release_date).toISOString().split('T')[0] : null

        if (oldEp.name_ru !== ep.name_ru || oldDate !== newDate) {
          // Обновляем, если изменилось
          await pool.query(
            `UPDATE seasons SET name_ru = $1, release_date = $2 
             WHERE movie_id = $3 AND season_number = $4 AND episode_number = $5`,
            [ep.name_ru, ep.release_date, kinopoiskId, ep.season_number, ep.episode_number]
          )
          changedCount++
        }
      } else {
        // Добавляем новую серию
        await pool.query(
          `INSERT INTO seasons (movie_id, season_number, episode_number, name_ru, release_date)
           VALUES ($1, $2, $3, $4, $5)`,
          [kinopoiskId, ep.season_number, ep.episode_number, ep.name_ru, ep.release_date]
        )
        changedCount++
      }
    }

    return { changed: changedCount, error: null }
  } catch (err) {
    console.error(`Ошибка обновления сезонов для ${kinopoiskId}:`, err.message)
    return { changed: 0, error: err.message }
  }
}

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

  // ── 1. Сравнение скалярных полей ──────────────────────────────────
  const changed = []
  const updateValues = {} // field → новое значение (для динамического SET)

  for (const [dbField, apiField] of Object.entries(FIELD_MAP)) {
    const oldNorm = normalizeForCompare(current[dbField], dbField)
    const newRaw = fresh[apiField]
    const newNorm = normalizeForCompare(newRaw, dbField)

    // 1. Если API вернул null, а у нас уже есть маркер "Отсутствует" или 0 — это не изменение
    if (newNorm === null) {
      if (oldNorm === 'Отсутствует' || oldNorm === 0) continue
    }

    // 2. Если у нас в базе 0, а API вернул не null (какое-то значение) — это изменение (например, рейтинг появился)
    // Но если API вернул null, а у нас 0 — это тоже НЕ изменение (см. п.1)
    if (oldNorm === 0 && newNorm === null) continue

    // 3. Если оба null или оба 'Отсутствует' — пропускаем
    if (oldNorm === newNorm) continue

    // 4. Если API вернул null, а у нас есть реальные данные — не затираем
    if (newNorm === null && oldNorm !== null && oldNorm !== 0 && oldNorm !== 'Отсутствует') continue

    // 5. Если API вернул null, а у нас в базе null — записываем маркер (0 для чисел, 'Отсутствует' для строк)
    if (newNorm === null && oldNorm === null) {
      const isNumeric = NUMERIC_FIELDS.has(dbField)
      const fallback = isNumeric ? 0 : 'Отсутствует'
      
      changed.push({ field: dbField, old: null, new: fallback })
      updateValues[dbField] = fallback
      continue
    }

    // 6. Если API вернул значение, а у нас 0 или 'Отсутствует' — это изменение, обновляем на реальное
    if (newNorm !== null && (oldNorm === 0 || oldNorm === 'Отсутствует')) {
      changed.push({ field: dbField, old: oldNorm, new: newNorm })
      updateValues[dbField] = newRaw ?? null
      continue
    }

    // 7. Во всех остальных случаях (изменилось реальное значение)
    if (oldNorm !== newNorm) {
      changed.push({ field: dbField, old: oldNorm, new: newNorm })
      updateValues[dbField] = newRaw ?? null
    }
  }

  // ── 2. Жанры ──────────────────────────────────────────────────────
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

  // ── 3. Страны ─────────────────────────────────────────────────────
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

  // ── 4. UPDATE только изменённых полей ─────────────────────────────
  const setClauses = []
  const values = [kinopoiskId]
  let paramIdx = 2

  for (const { field } of changed) {
    if (!(field in updateValues)) continue
    setClauses.push(`${field} = $${paramIdx}`)
    values.push(updateValues[field])
    paramIdx++
  }

  if (setClauses.length > 0) {
    setClauses.push('updated_at = NOW()')
    await pool.query(
      `UPDATE movies SET ${setClauses.join(', ')} WHERE kinopoisk_id = $1`,
      values
    )
  }

  // ── 5. Жанры / страны — батч-вставка ──────────────────────────────
  if (genresChanged && freshGenres.length > 0) {
    await pool.query('DELETE FROM movie_genres WHERE movie_id = $1', [kinopoiskId])
    await pool.query(
      `INSERT INTO movie_genres (movie_id, genre)
       SELECT $1, unnest($2::text[])
       ON CONFLICT DO NOTHING`,
      [kinopoiskId, freshGenres]
    )
  }

  if (countriesChanged && freshCountries.length > 0) {
    await pool.query('DELETE FROM movie_countries WHERE movie_id = $1', [kinopoiskId])
    await pool.query(
      `INSERT INTO movie_countries (movie_id, country)
       SELECT $1, unnest($2::text[])
       ON CONFLICT DO NOTHING`,
      [kinopoiskId, freshCountries]
    )
  }

  // ── 6. Отмечаем проверку (всегда) ─────────────────────────────────
  await pool.query(
    `UPDATE movies SET last_checked_at = NOW() WHERE kinopoisk_id = $1`,
    [kinopoiskId]
  )

  // ── 7. Обновление сезонов для сериалов ───────────────────────────
  if (fresh.type === 'TV_SERIES' || fresh.type === 'MINI_SERIES') {
    const seasonsResult = await updateSeasonsForMovie(kinopoiskId)

    if (seasonsResult.error) {
      // Если ошибка (например, лимит API), просто логируем
      if (seasonsResult.error.startsWith('HTTP')) {
        // Если лимит — прерываем
        if (seasonsResult.error === 'HTTP 402' || seasonsResult.error === 'HTTP 429') {
          return { changed, error: seasonsResult.error }
        }
      }
      // В остальных случаях не ломаем основной процесс
    } else if (seasonsResult.changed > 0) {
      changed.push({
        field: 'seasons',
        old: '-',
        new: `Обновлено серий: ${seasonsResult.changed}`
      })
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

async function cleanupOldMatchRooms() {
  try {
    const result = await pool.query(
      `DELETE FROM match_rooms 
       WHERE status = 'cancelled' AND cancelled_at < NOW() - INTERVAL '7 days'`
    )
    if (result.rowCount > 0) {
      logUpdate(`🧹 Удалено старых отмененных комнат: ${result.rowCount}`)
    }
  } catch (err) {
    logError('cleanup-match-rooms', err.message)
  }
}

async function updateOldMovies() {
  logUpdate('Проверяю фильмы для обновления...')

  try {
    // Собираем фильмы по "локальному" обновлению (старые по last_checked_at)
    const result = await pool.query(
      `SELECT kinopoisk_id
       FROM movies
       ORDER BY COALESCE(last_checked_at, updated_at, created_at) ASC
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
    let processedIds = [] // Собираем ID, которые прошли обновление

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

        // Запоминаем успешные ID
        processedIds.push(row.kinopoisk_id)

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

    // ── ГЛОБАЛЬНОЕ ОБНОВЛЕНИЕ ДАТ ──────────────────────────────────
    // Проставляем last_checked_at_all для всех, кто был в пачке
    if (processedIds.length > 0) {
      await pool.query(
        `UPDATE movies SET last_checked_at_all = NOW() WHERE kinopoisk_id = ANY($1)`,
        [processedIds]
      )
      logUpdate(`📅 Отмечено глобальное обновление для ${processedIds.length} фильмов`)
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
  await cleanupOldMatchRooms()
}

async function checkAndUpdateOnStartup() {
  try {
    const result = await pool.query(
      `SELECT MAX(last_checked_at_all) as last_full_update FROM movies`
    )

    const lastFullUpdate = result.rows[0]?.last_full_update
    const now = new Date()


    if (!lastFullUpdate) {
      console.log('🕒 Глобальное обновление никогда не запускалось. Запускаю...')
      updateOldMovies()
      return
    }

    // Принудительно приводим к UTC
    const lastTime = new Date(lastFullUpdate).getTime()
    const nowTime = now.getTime()

    // Если разница отрицательная (время из будущего) — значит, часы сбиты
    // В этом случае лучше запустить обновление
    if (nowTime < lastTime) {
      console.log('🕒 Время из БД в будущем. Часовые пояса сбиты. Запускаю обновление...')
      updateOldMovies()
      return
    }

    const diffHours = (nowTime - lastTime) / (1000 * 60 * 60)

    if (diffHours >= 8) {
      console.log(`🕒 Прошло ${Math.round(diffHours)} ч. с последнего глобального обновления. Запускаю...`)
      updateOldMovies()
    } else {
      console.log(`🕒 Глобальное обновление было ${Math.round(diffHours)} ч. назад. Пропускаю.`)
    }
  } catch (err) {
    console.error('Ошибка проверки времени обновления:', err)
  }
}

// Проверяем при старте сервера (через 5 секунд, чтобы БД успела подключиться)
setTimeout(checkAndUpdateOnStartup, 7500)

httpServer.listen(process.env.PORT, () => {
  console.log(`Сервер запущен на порту ${process.env.PORT}`)
})