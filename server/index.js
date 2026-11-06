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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

const TMDB_TOKEN = process.env.TMDB_ACCESS_TOKEN
const TMDB_BASE = 'https://api.themoviedb.org/3'

// ───────────────────────── SOCKET.IO ─────────────────────────

const httpServer = http.createServer(app)
const io = new Server(httpServer, {
  cors: { origin: '*', credentials: true },
})

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

    for (const roomId of socket.activeRooms) {
      try {
        const roomResult = await pool.query(
          `SELECT id, status, organizer_id FROM match_rooms WHERE id = $1`,
          [roomId]
        )
        if (roomResult.rows.length === 0) continue
        const room = roomResult.rows[0]
        if (room.status === 'cancelled') continue

        setTimeout(async () => {
          try {
            const checkUser = await pool.query(
              `SELECT * FROM match_participants WHERE room_id = $1 AND user_id = $2`,
              [roomId, userId]
            )
            if (checkUser.rows.length === 0) return
            if (onlineUsers.has(userId)) {
              console.log(`ℹ️  @${socket.userName} вернулся в комнату ${roomId}`)
              return
            }

            await pool.query(
              `UPDATE match_rooms SET status = 'cancelled', cancelled_by = $1, cancelled_at = NOW() WHERE id = $2 AND status != 'cancelled'`,
              [userId, roomId]
            )
            console.log(`❌ Комната ${roomId} отменена — @${socket.userName} ушёл`)
            io.to(`match_room_${roomId}`).emit('match:cancelled', {
              roomId,
              cancelledByName: socket.userName,
              reason: 'disconnect',
            })
          } catch (err) {
            console.error('Ошибка обработки отключения:', err.message)
          }
        }, 30000)
      } catch (err) {
        console.error('Ошибка при disconnect:', err.message)
      }
    }
  })
})

function emitNotification(userId, data) {
  const socketId = onlineUsers.get(userId)
  if (socketId) io.to(socketId).emit('notification', data)
}

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

  const notEmptyText = (val) =>
    val === null || val === undefined || val === 'null' ? '—' : val

  const notEmptyNum = (val) => {
    if (val === null || val === undefined) return 0
    if (typeof val === 'string' && /^\d{1,2}:\d{2}$/.test(val.trim())) {
      const [h, m] = val.trim().split(':').map(Number)
      return h * 60 + m
    }
    const num = Number(val)
    return Number.isFinite(num) ? num : 0
  }

  try {
    const result = await pool.query(
      `INSERT INTO movies (
        kinopoisk_id, name_ru, name_en, name_original, year, type,
        poster_url, poster_url_preview, rating_kinopoisk, rating_imdb,
        description, film_length, slogan
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (kinopoisk_id) DO UPDATE SET
        name_ru = EXCLUDED.name_ru, name_en = EXCLUDED.name_en, name_original = EXCLUDED.name_original,
        year = EXCLUDED.year, type = EXCLUDED.type, poster_url = EXCLUDED.poster_url,
        poster_url_preview = EXCLUDED.poster_url_preview, rating_kinopoisk = EXCLUDED.rating_kinopoisk,
        rating_imdb = EXCLUDED.rating_imdb, description = EXCLUDED.description,
        film_length = EXCLUDED.film_length, slogan = EXCLUDED.slogan, updated_at = NOW()
      RETURNING *`,
      [
        movie.kinopoiskId, notEmptyText(movie.nameRu), notEmptyText(movie.nameEn),
        notEmptyText(movie.nameOriginal), notEmptyNum(movie.year), notEmptyText(movie.type),
        notEmptyText(movie.posterUrl), notEmptyText(movie.posterUrlPreview),
        notEmptyNum(movie.ratingKinopoisk), notEmptyNum(movie.ratingImdb),
        notEmptyText(movie.description), notEmptyNum(movie.filmLength), notEmptyText(movie.slogan),
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
      `INSERT INTO notifications (user_id, type, message, link) VALUES ($1, $2, $3, $4)`,
      [userId, type, message, link]
    )
    emitNotification(userId, { type, message, link })
  } catch (err) {
    console.error('Ошибка создания уведомления:', err.message)
  }
}

// ───────────────────────── TMDB HELPERS ─────────────────────────

async function getTmdbEpisodes(tmdbId, kinopoiskId) {
  if (!TMDB_TOKEN) return []

  // 1. Проверяем кэш (6 месяцев - требование TMDB)
  const cached = await pool.query(
    `SELECT * FROM tmdb_episodes WHERE movie_id = $1 AND created_at > NOW() - INTERVAL '6 months' ORDER BY season_number, episode_number`,
    [kinopoiskId]
  )
  if (cached.rows.length > 0) return cached.rows

  // 2. Идем в TMDB
  try {
    const tvRes = await fetch(`${TMDB_BASE}/tv/${tmdbId}?language=ru-RU`, {
      headers: { Authorization: `Bearer ${TMDB_TOKEN}` },
    })
    if (!tvRes.ok) return []
    const tvData = await tvRes.json()

    const allEpisodes = []

    for (const season of tvData.seasons || []) {
      if (season.season_number === 0) continue // Пропускаем спецвыпуски

      const seasonRes = await fetch(
        `${TMDB_BASE}/tv/${tmdbId}/season/${season.season_number}?language=ru-RU`,
        { headers: { Authorization: `Bearer ${TMDB_TOKEN}` } }
      )
      if (!seasonRes.ok) continue

      const seasonData = await seasonRes.json()
      for (const ep of seasonData.episodes || []) {
        if (ep.episode_number == null) continue

        allEpisodes.push({
          season_number: ep.season_number,
          episode_number: ep.episode_number,
          name_ru: ep.name || null,
          air_date: ep.air_date || null,
          overview: ep.overview || null,
          tmdb_episode_id: ep.id,
        })
      }
    }

    // 3. Сохраняем в кэш
    if (allEpisodes.length > 0) {
      await pool.query('DELETE FROM tmdb_episodes WHERE movie_id = $1', [kinopoiskId])
      for (const ep of allEpisodes) {
        await pool.query(
          `INSERT INTO tmdb_episodes (movie_id, season_number, episode_number, name_ru, air_date, overview, tmdb_episode_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [kinopoiskId, ep.season_number, ep.episode_number, ep.name_ru, ep.air_date, ep.overview, ep.tmdb_episode_id]
        )
      }
    }

    return allEpisodes
  } catch (err) {
    console.error(`Ошибка TMDB для ${tmdbId}:`, err.message)
    return []
  }
}

async function tmdbFetch(url, retries = 1) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TMDB_TOKEN}` },
  })

  if (res.status === 429 && retries > 0) {
    const retryAfter = parseInt(res.headers.get('retry-after') || '60')
    console.log(`  ⏸️  Rate limit TMDB, ждём ${retryAfter}s...`)
    await new Promise((r) => setTimeout(r, retryAfter * 1000))
    return tmdbFetch(url, retries - 1)
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`TMDB HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  return res.json()
}

async function findTmdbId(nameRu, nameEn, nameOriginal, year, type) {
  if (!TMDB_TOKEN) return null

  const searchType = (type === 'TV_SERIES' || type === 'MINI_SERIES') ? 'tv' : 'movie'

  // Собираем все названия (ru, original, en)
  const names = [
    { name: nameRu, lang: 'ru-RU' },
    { name: nameOriginal, lang: 'en-US' },
    { name: nameEn, lang: 'en-US' },
  ].filter(
    (n) => n.name && n.name.trim() !== '' && n.name !== 'null' && n.name !== '—'
  )

  const seen = new Set()
  const uniqueNames = []
  for (const n of names) {
    const key = n.name.toLowerCase().trim()
    if (seen.has(key)) continue
    seen.add(key)
    uniqueNames.push(n)
  }

  const attempts = []
  for (const { name, lang } of uniqueNames) {
    if (year > 0) attempts.push({ name, lang, withYear: true })
    attempts.push({ name, lang, withYear: false })
  }

  for (const attempt of attempts) {
    try {
      const yearParam = attempt.withYear && year > 0 ? `&year=${year}` : ''
      const url = `${TMDB_BASE}/search/${searchType}?query=${encodeURIComponent(attempt.name)}&language=${attempt.lang}${yearParam}`
      const data = await tmdbFetch(url)

      if (data.results && data.results.length > 0) {
        let best = data.results[0]
        if (year > 0) {
          const exactYear = data.results.find((r) => {
            const rYear = parseInt((r.release_date || r.first_air_date || '').slice(0, 4)) || 0
            return rYear === year
          })
          if (exactYear) best = exactYear
        }

        let imdbId = null
        try {
          const detailsUrl = `${TMDB_BASE}/${searchType}/${best.id}?append_to_response=external_ids`
          const details = await tmdbFetch(detailsUrl)
          imdbId = details.external_ids?.imdb_id || null
        } catch (e) {
          // Игнорируем ошибку получения IMDb, главное ID найден
        }

        return { tmdbId: best.id, imdbId }
      }
    } catch (err) {
      console.error(`  ⚠️  "${attempt.name}" (${attempt.lang}${attempt.withYear ? `, ${year}` : ''}): ${err.message}`)
      if (err.cause) console.error(`      cause: ${err.cause.code || err.cause.message}`)
    }
    await new Promise((r) => setTimeout(r, 150))
  }

  return null
}

async function syncMissingTmdbIds() {
  if (!TMDB_TOKEN) {
    console.log('⚠️  TMDB_ACCESS_TOKEN не задан — пропускаю синхронизацию TMDB')
    return
  }

  console.log('\n🎬 Начинаю догоняющую синхронизацию TMDB ID...')

  const { rows } = await pool.query(`
    SELECT kinopoisk_id, name_ru, name_en, name_original, year, type
    FROM movies
    WHERE tmdb_id IS NULL
      AND (
        (name_ru IS NOT NULL AND name_ru <> '—' AND name_ru <> 'null')
        OR (name_en IS NOT NULL AND name_en <> '—' AND name_en <> 'null')
        OR (name_original IS NOT NULL AND name_original <> '—' AND name_original <> 'null')
      )
    ORDER BY kinopoisk_id ASC
  `)

  if (rows.length === 0) {
    console.log('✅ Все фильмы с названиями уже имеют TMDB ID\n')
    return
  }

  console.log(`Найдено ${rows.length} фильмов без TMDB ID\n`)

  let success = 0
  let notFound = 0
  let errors = 0

  for (let i = 0; i < rows.length; i++) {
    const movie = rows[i]

    try {
      const match = await findTmdbId(
        movie.name_ru,
        movie.name_en,
        movie.name_original,
        movie.year,
        movie.type
      )

      if (match) {
        await pool.query(
          `UPDATE movies
           SET tmdb_id = $1,
               imdb_id = COALESCE(imdb_id, $2),
               tmdb_last_synced_at = NOW()
           WHERE kinopoisk_id = $3`,
          [match.tmdbId, match.imdbId, movie.kinopoisk_id]
        )
        success++
        console.log(`[${i + 1}/${rows.length}] ✅ ${movie.name_ru || movie.name_original || movie.name_en} → ${match.tmdbId}`)
      } else {
        notFound++
        console.log(`[${i + 1}/${rows.length}] ❌ Не найден: ${movie.name_ru || movie.name_original || movie.name_en}`)
      }
    } catch (err) {
      errors++
      console.error(`[${i + 1}/${rows.length}] 💥 ${movie.name_ru || movie.kinopoisk_id}: ${err.message}`)
    }

    // Прогресс-репорт каждые 100 фильмов
    if ((i + 1) % 100 === 0) {
      console.log(`  📊 Прогресс: ${i + 1}/${rows.length} (✅ ${success} / ❌ ${notFound} / 💥 ${errors})`)
    }

    await new Promise((r) => setTimeout(r, 150))
  }

  console.log(`\n🏁 TMDB sync готово: ✅ ${success} / ❌ ${notFound} / 💥 ${errors}\n`)
}

// ───────────────────────── ROUTES ─────────────────────────

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
    if (err.code === '23505') return res.status(400).json({ error: 'Email или ник уже заняты' })
    res.status(500).json({ error: 'Ошибка регистрации' })
  }
})

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email])
    if (result.rows.length === 0) return res.status(400).json({ error: 'Пользователь не найден' })
    const user = result.rows[0]
    const match = await bcrypt.compare(password, user.password_hash)
    if (!match) return res.status(400).json({ error: 'Неверный пароль' })

    const token = jwt.sign({ id: user.id, name: user.name }, process.env.JWT_SECRET, { expiresIn: '30d' })
    res.json({ token, user: { id: user.id, name: user.name, email: user.email } })
  } catch (err) {
    res.status(500).json({ error: 'Ошибка входа' })
  }
})

app.post('/api/import/upload', authMiddleware, upload.single('file'), async (req, res) => {
  const userId = req.user.id
  const file = req.file
  const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN
  const CHAT_ID = process.env.TELEGRAM_CHAT_ID

  if (!file) return res.status(400).json({ error: 'Файл не загружен' })
  const ext = file.originalname.split('.').pop().toLowerCase()
  if (ext !== 'xlsx') return res.status(400).json({ error: 'Поддерживается только формат .xlsx' })

  const magicBytes = file.buffer.slice(0, 4).toString('hex').toUpperCase()
  if (magicBytes !== '504B0304') return res.status(400).json({ error: 'Файл поврежден или не является настоящим .xlsx' })

  if (!TELEGRAM_TOKEN || !CHAT_ID) return res.status(500).json({ error: 'Telegram не настроен' })

  try {
    const formData = new FormData()
    formData.append('chat_id', CHAT_ID)
    formData.append('caption', `Новый импорт фильмов от пользователя #${userId}`)
    const blob = new Blob([file.buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    formData.append('document', blob, file.originalname)

    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendDocument`, {
      method: 'POST',
      body: formData,
    })
    const data = await response.json()
    if (!data.ok) throw new Error(data.description || 'Ошибка Telegram API')
    res.json({ success: true, message: 'Файл отправлен в Telegram' })
  } catch (err) {
    res.status(500).json({ error: 'Не удалось отправить файл.' })
  }
})

app.get('/api/kinopoisk/:id/watched-episodes', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT season_number, episode_number FROM user_episodes WHERE user_id = $1 AND movie_id = $2',
      [req.user.id, req.params.id]
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
        `INSERT INTO user_episodes (user_id, movie_id, season_number, episode_number) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [userId, movieId, seasonNumber, episodeNumber]
      )
    } else {
      await pool.query(
        `DELETE FROM user_episodes WHERE user_id = $1 AND movie_id = $2 AND season_number = $3 AND episode_number = $4`,
        [userId, movieId, seasonNumber, episodeNumber]
      )
    }

    const movie = await pool.query('SELECT tmdb_id, type FROM movies WHERE kinopoisk_id = $1', [movieId])
    const kpEpisodes = await pool.query(`SELECT season_number, episode_number, release_date FROM seasons WHERE movie_id = $1`, [movieId])

    let allEpisodes = kpEpisodes.rows
    if (movie.rows.length > 0 && movie.rows[0].tmdb_id && movie.rows[0].type !== 'FILM') {
      const tmdbEps = await getTmdbEpisodes(movie.rows[0].tmdb_id, movieId)
      const map = new Map()
      allEpisodes.forEach(e => map.set(`${e.season_number}-${e.episode_number}`, e))
      tmdbEps.forEach(e => {
        if (!map.has(`${e.season_number}-${e.episode_number}`)) map.set(`${e.season_number}-${e.episode_number}`, e)
      })
      allEpisodes = Array.from(map.values())
    }

    const aired = allEpisodes.filter(e => e.release_date ? new Date(e.release_date) <= new Date() : e.air_date ? new Date(e.air_date) <= new Date() : false)
    const watchedEpisodes = await pool.query(
      `SELECT season_number, episode_number FROM user_episodes WHERE user_id = $1 AND movie_id = $2`,
      [userId, movieId]
    )

    const totalAired = aired.length
    const totalWatched = watchedEpisodes.rows.length

    let newStatus = 'watching'
    if (totalAired > 0 && totalWatched >= totalAired) newStatus = 'watched'

    await pool.query(
      `INSERT INTO user_movies (user_id, movie_id, status) VALUES ($1, $2, $3) 
       ON CONFLICT (user_id, movie_id) DO UPDATE SET status = EXCLUDED.status`,
      [userId, movieId, newStatus]
    )

    res.json({ success: true, newStatus })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка отметки серии' })
  }
})

app.post('/api/episodes/bulk-toggle', authMiddleware, async (req, res) => {
  const { movieId, seasonNumber, episodes, watched } = req.body
  const userId = req.user.id
  const client = await pool.connect()

  try {
    await client.query('BEGIN')
    for (const ep of episodes) {
      if (watched) {
        await client.query(
          `INSERT INTO user_episodes (user_id, movie_id, season_number, episode_number) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
          [userId, movieId, seasonNumber, ep.episode_number]
        )
      } else {
        await client.query(
          `DELETE FROM user_episodes WHERE user_id = $1 AND movie_id = $2 AND season_number = $3 AND episode_number = $4`,
          [userId, movieId, seasonNumber, ep.episode_number]
        )
      }
    }

    const movie = await client.query('SELECT tmdb_id, type FROM movies WHERE kinopoisk_id = $1', [movieId])
    const kpEpisodes = await client.query(`SELECT season_number, episode_number, release_date FROM seasons WHERE movie_id = $1`, [movieId])

    let allEpisodes = kpEpisodes.rows
    if (movie.rows.length > 0 && movie.rows[0].tmdb_id && movie.rows[0].type !== 'FILM') {
      const tmdbEps = await getTmdbEpisodes(movie.rows[0].tmdb_id, movieId)
      const map = new Map()
      allEpisodes.forEach(e => map.set(`${e.season_number}-${e.episode_number}`, e))
      tmdbEps.forEach(e => {
        if (!map.has(`${e.season_number}-${e.episode_number}`)) map.set(`${e.season_number}-${e.episode_number}`, e)
      })
      allEpisodes = Array.from(map.values())
    }

    const aired = allEpisodes.filter(e => e.release_date ? new Date(e.release_date) <= new Date() : e.air_date ? new Date(e.air_date) <= new Date() : false)
    const watchedEps = await client.query(
      `SELECT season_number, episode_number FROM user_episodes WHERE user_id = $1 AND movie_id = $2`,
      [userId, movieId]
    )

    let newStatus = 'watching'
    if (aired.length > 0 && watchedEps.rows.length >= aired.length) {
      newStatus = 'watched'
    } else if (watchedEps.rows.length === 0) {
      await client.query('DELETE FROM user_movies WHERE user_id = $1 AND movie_id = $2', [userId, movieId])
      await client.query('COMMIT')
      return res.json({ success: true, newStatus: 'not_watched' })
    }

    await client.query(
      `INSERT INTO user_movies (user_id, movie_id, status) VALUES ($1, $2, $3) 
       ON CONFLICT (user_id, movie_id) DO UPDATE SET status = EXCLUDED.status`,
      [userId, movieId, newStatus]
    )

    await client.query('COMMIT')
    res.json({ success: true, newStatus })
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Ошибка массовой отметки' })
  } finally {
    client.release()
  }
})

app.post('/api/movies/bulk-statuses', authMiddleware, async (req, res) => {
  const { movieIds } = req.body
  if (!movieIds || !Array.isArray(movieIds) || movieIds.length === 0) return res.json({ statuses: {} })
  try {
    const result = await pool.query(
      'SELECT movie_id, status FROM user_movies WHERE user_id = $1 AND movie_id = ANY($2)',
      [req.user.id, movieIds]
    )
    const statuses = {}
    result.rows.forEach((row) => { statuses[row.movie_id] = row.status })
    res.json({ statuses })
  } catch (err) {
    res.status(500).json({ error: 'Ошибка получения статусов' })
  }
})

app.get('/api/movies/:movieId', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT status FROM user_movies WHERE user_id = $1 AND movie_id = $2',
      [req.user.id, req.params.movieId]
    )
    if (result.rows.length === 0) return res.json({ status: 'not_watched' })
    res.json({ status: result.rows[0].status })
  } catch (err) {
    res.status(500).json({ error: 'Ошибка получения статуса' })
  }
})

app.post('/api/movies/:movieId', authMiddleware, async (req, res) => {
  const { movieId } = req.params
  const { status } = req.body
  const userId = req.user.id

  if (status === 'not_watched') {
    try {
      const watchedResult = await pool.query(
        'SELECT COUNT(*) FROM user_episodes WHERE user_id = $1 AND movie_id = $2',
        [userId, movieId]
      )
      if (parseInt(watchedResult.rows[0].count) > 0) {
        return res.status(400).json({ error: 'Нельзя сбросить статус, пока отмечены серии.' })
      }
      await pool.query('DELETE FROM user_movies WHERE user_id = $1 AND movie_id = $2', [userId, movieId])
      return res.json({ status: 'not_watched' })
    } catch (err) {
      return res.status(500).json({ error: 'Ошибка удаления' })
    }
  }

  const allowed = ['want_to_watch', 'watched', 'watching']
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Неверный статус' })

  if (status === 'watched') {
    const movieType = await pool.query('SELECT type FROM movies WHERE kinopoisk_id = $1', [movieId])
    if (movieType.rows[0]?.type === 'TV_SERIES' || movieType.rows[0]?.type === 'MINI_SERIES') {
      return res.status(400).json({ error: 'Сериалы нельзя отметить напрямую.' })
    }
  }

  try {
    const result = await pool.query(
      `INSERT INTO user_movies (user_id, movie_id, status) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, movie_id) DO UPDATE SET status = EXCLUDED.status RETURNING *`,
      [userId, movieId, status]
    )
    res.json(result.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сохранения статуса' })
  }
})

app.get('/api/users/search', authMiddleware, async (req, res) => {
  const { name } = req.query
  if (!name) return res.status(400).json({ error: 'Введите ник' })
  try {
    const result = await pool.query('SELECT id, name FROM users WHERE name = $1 AND id != $2', [name, req.user.id])
    if (result.rows.length === 0) return res.status(404).json({ error: 'Пользователь не найден' })
    res.json(result.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Ошибка поиска' })
  }
})

app.get('/api/friends', authMiddleware, async (req, res) => {
  const userId = req.user.id
  try {
    const friendsResult = await pool.query(
      `SELECT u.id, u.name, f.id AS friendship_id, f.status
       FROM friendships f JOIN users u ON u.id = CASE WHEN f.user_id_1 = $1 THEN f.user_id_2 ELSE f.user_id_1 END
       WHERE (f.user_id_1 = $1 OR f.user_id_2 = $1) AND f.status = 'accepted'`, [userId]
    )
    const requestsResult = await pool.query(
      `SELECT u.id, u.name, f.id AS friendship_id, f.status
       FROM friendships f JOIN users u ON u.id = f.user_id_1
       WHERE f.user_id_2 = $1 AND f.status = 'pending'`, [userId]
    )
    res.json({ friends: friendsResult.rows, requests: requestsResult.rows })
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки друзей' })
  }
})

app.post('/api/friends', authMiddleware, async (req, res) => {
  const { friendId } = req.body
  const userId = req.user.id
  if (userId === friendId) return res.status(400).json({ error: 'Нельзя добавить себя' })

  try {
    const existing = await pool.query(
      `SELECT * FROM friendships WHERE (user_id_1 = $1 AND user_id_2 = $2) OR (user_id_1 = $2 AND user_id_2 = $1)`,
      [userId, friendId]
    )
    if (existing.rows.length > 0) return res.status(400).json({ error: 'Заявка уже существует' })

    const result = await pool.query(
      `INSERT INTO friendships (user_id_1, user_id_2, status) VALUES ($1, $2, 'pending') RETURNING *`,
      [userId, friendId]
    )
    const senderResult = await pool.query('SELECT name FROM users WHERE id = $1', [userId])
    await createNotification(friendId, 'friend_request', `@${senderResult.rows[0]?.name || 'Кто-то'} отправил вам заявку в друзья`, '/friends')
    io.emit('friends:updated', { userIds: [userId, friendId] })
    res.json(result.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Ошибка отправки заявки' })
  }
})

app.patch('/api/friends/:id', authMiddleware, async (req, res) => {
  const { id } = req.params
  const userId = req.user.id
  try {
    const result = await pool.query(
      `UPDATE friendships SET status = 'accepted' WHERE id = $1 AND user_id_2 = $2 RETURNING *`, [id, userId]
    )
    if (result.rows.length === 0) return res.status(404).json({ error: 'Заявка не найдена' })
    const friendship = result.rows[0]
    const accepterResult = await pool.query('SELECT name FROM users WHERE id = $1', [userId])
    await createNotification(friendship.user_id_1, 'friend_accepted', `@${accepterResult.rows[0]?.name || 'Кто-то'} принял вашу заявку в друзья`, '/friends')
    io.emit('friends:updated', { userIds: [friendship.user_id_1, friendship.user_id_2] })
    res.json(friendship)
  } catch (err) {
    res.status(500).json({ error: 'Ошибка принятия заявки' })
  }
})

app.delete('/api/friends/:id', authMiddleware, async (req, res) => {
  const { id } = req.params
  const userId = req.user.id
  try {
    const result = await pool.query(
      `DELETE FROM friendships WHERE id = $1 AND (user_id_1 = $2 OR user_id_2 = $2) RETURNING *`, [id, userId]
    )
    if (result.rows.length === 0) return res.status(404).json({ error: 'Связь не найдена' })
    const f = result.rows[0]
    io.emit('friends:updated', { userIds: [f.user_id_1, f.user_id_2] })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: 'Ошибка удаления' })
  }
})

app.get('/api/notifications', authMiddleware, async (req, res) => {
  const userId = req.user.id
  try {
    const result = await pool.query(`SELECT id, type, message, link, read, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [userId])
    const unreadCount = await pool.query('SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND read = FALSE', [userId])
    res.json({ notifications: result.rows, unreadCount: parseInt(unreadCount.rows[0].count) })
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки уведомлений' })
  }
})

app.patch('/api/notifications/:id/read', authMiddleware, async (req, res) => {
  try {
    await pool.query('UPDATE notifications SET read = TRUE WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id])
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: 'Ошибка' })
  }
})

app.patch('/api/notifications/read-all', authMiddleware, async (req, res) => {
  try {
    await pool.query('UPDATE notifications SET read = TRUE WHERE user_id = $1 AND read = FALSE', [req.user.id])
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: 'Ошибка' })
  }
})

app.get('/api/users/me/watching', authMiddleware, async (req, res) => {
  const userId = req.user.id
  try {
    const moviesResult = await pool.query(
      `SELECT m.kinopoisk_id AS "kinopoiskId", m.name_ru AS "nameRu", m.name_en AS "nameEn", m.poster_url_preview AS "posterUrlPreview", m.year, m.tmdb_id
       FROM user_movies um JOIN movies m ON m.kinopoisk_id = um.movie_id
       WHERE um.user_id = $1 AND um.status = 'watching' ORDER BY um.id DESC`, [userId]
    )

    const series = []
    for (const movie of moviesResult.rows) {
      const kpEpisodes = await pool.query(`SELECT season_number, episode_number, release_date FROM seasons WHERE movie_id = $1`, [movie.kinopoiskId])

      let allEpisodes = kpEpisodes.rows
      if (movie.tmdb_id) {
        const tmdbEps = await getTmdbEpisodes(movie.tmdb_id, movie.kinopoiskId)
        const map = new Map()
        allEpisodes.forEach(e => map.set(`${e.season_number}-${e.episode_number}`, e))
        tmdbEps.forEach(e => {
          if (!map.has(`${e.season_number}-${e.episode_number}`)) map.set(`${e.season_number}-${e.episode_number}`, e)
        })
        allEpisodes = Array.from(map.values())
      }

      const aired = allEpisodes.filter(e => e.release_date ? new Date(e.release_date) <= new Date() : e.air_date ? new Date(e.air_date) <= new Date() : false)
      const watchedEpisodes = await pool.query(`SELECT season_number, episode_number FROM user_episodes WHERE user_id = $1 AND movie_id = $2`, [userId, movie.kinopoiskId])
      const watchedSet = new Set(watchedEpisodes.rows.map(e => `${e.season_number}-${e.episode_number}`))

      let nextEpisode = null
      for (const ep of aired.sort((a, b) => a.season_number - b.season_number || a.episode_number - b.episode_number)) {
        if (!watchedSet.has(`${ep.season_number}-${ep.episode_number}`)) {
          nextEpisode = ep
          break
        }
      }

      series.push({
        ...movie,
        nextSeason: nextEpisode ? nextEpisode.season_number : null,
        nextEpisode: nextEpisode ? nextEpisode.episode_number : null,
        nextEpisodeName: nextEpisode ? (nextEpisode.name_ru || null) : null,
        nextEpisodeDate: nextEpisode ? (nextEpisode.release_date || nextEpisode.air_date) : null,
        remaining: aired.length - watchedSet.size,
        totalAired: aired.length,
        watchedCount: watchedSet.size,
      })
    }
    res.json({ series })
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки сериалов' })
  }
})

app.get('/api/users/me/watchlist-series', authMiddleware, async (req, res) => {
  const userId = req.user.id
  try {
    const result = await pool.query(
      `SELECT m.kinopoisk_id AS "kinopoiskId", m.name_ru AS "nameRu", m.name_en AS "nameEn", m.name_original AS "nameOriginal",
        m.year, m.type, m.poster_url_preview AS "posterUrlPreview", m.rating_kinopoisk AS "ratingKinopoisk",
        m.rating_imdb AS "ratingImdb", m.film_length AS "filmLength", m.tmdb_id
       FROM user_movies um JOIN movies m ON m.kinopoisk_id = um.movie_id
       WHERE um.user_id = $1 AND um.status = 'want_to_watch' AND m.type IN ('TV_SERIES', 'MINI_SERIES', 'TV_SHOW')
       ORDER BY um.id DESC`, [userId]
    )

    const series = []
    for (const row of result.rows) {
      const kpEpisodes = await pool.query(`SELECT season_number, episode_number, release_date FROM seasons WHERE movie_id = $1`, [row.kinopoiskId])
      let allEpisodes = kpEpisodes.rows
      if (row.tmdb_id) {
        const tmdbEps = await getTmdbEpisodes(row.tmdb_id, row.kinopoiskId)
        const map = new Map()
        allEpisodes.forEach(e => map.set(`${e.season_number}-${e.episode_number}`, e))
        tmdbEps.forEach(e => {
          if (!map.has(`${e.season_number}-${e.episode_number}`)) map.set(`${e.season_number}-${e.episode_number}`, e)
        })
        allEpisodes = Array.from(map.values())
      }
      const aired = allEpisodes.filter(e => e.release_date ? new Date(e.release_date) <= new Date() : e.air_date ? new Date(e.air_date) <= new Date() : false)

      const watchedResult = await pool.query('SELECT COUNT(*) FROM user_episodes WHERE user_id = $1 AND movie_id = $2', [userId, row.kinopoiskId])
      const watchedCount = parseInt(watchedResult.rows[0].count)
      const remaining = watchedCount > 0 ? Math.max(0, aired.length - watchedCount) : aired.length

      series.push({ ...row, episodesCount: aired.length, watchedCount, remaining })
    }
    res.json({ series })
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки списка сериалов' })
  }
})

app.get('/api/users/me/watchlist', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.kinopoisk_id AS "kinopoiskId", m.name_ru AS "nameRu", m.name_en AS "nameEn", m.name_original AS "nameOriginal",
        m.year, m.type, m.poster_url_preview AS "posterUrlPreview", m.rating_kinopoisk AS "ratingKinopoisk",
        m.rating_imdb AS "ratingImdb", m.film_length AS "filmLength", m.description
       FROM user_movies um JOIN movies m ON m.kinopoisk_id = um.movie_id
       WHERE um.user_id = $1 AND um.status = 'want_to_watch' AND m.type IN ('FILM', 'VIDEO') ORDER BY um.id DESC`, [req.user.id]
    )
    res.json({ movies: result.rows })
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки списка фильмов' })
  }
})

app.get('/api/users/:id', authMiddleware, async (req, res) => {
  const { id } = req.params
  const currentUserId = req.user.id
  try {
    const userResult = await pool.query('SELECT id, name, email, created_at FROM users WHERE id = $1', [id])
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'Пользователь не найден' })

    const user = userResult.rows[0]
    const countsResult = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'watched') AS watched, COUNT(*) FILTER (WHERE status = 'want_to_watch') AS want_to_watch FROM user_movies WHERE user_id = $1`, [id]
    )
    const friendsCountResult = await pool.query(`SELECT COUNT(*) FROM friendships WHERE (user_id_1 = $1 OR user_id_2 = $1) AND status = 'accepted'`, [id])

    let friendshipStatus = 'none', friendshipId = null, isFriend = false
    if (currentUserId !== parseInt(id)) {
      const friendshipResult = await pool.query(
        `SELECT id, user_id_1, user_id_2, status FROM friendships WHERE (user_id_1 = $1 AND user_id_2 = $2) OR (user_id_1 = $2 AND user_id_2 = $1) LIMIT 1`,
        [currentUserId, id]
      )
      if (friendshipResult.rows.length > 0) {
        const f = friendshipResult.rows[0]
        friendshipId = f.id
        if (f.status === 'accepted') { friendshipStatus = 'accepted'; isFriend = true }
        else if (f.status === 'pending') friendshipStatus = f.user_id_1 === currentUserId ? 'pending_outgoing' : 'pending_incoming'
      }
    }

    res.json({
      user: { id: user.id, name: user.name, email: currentUserId === parseInt(id) ? user.email : undefined, created_at: user.created_at },
      stats: { watched: parseInt(countsResult.rows[0].watched), want_to_watch: parseInt(countsResult.rows[0].want_to_watch), not_watched: 0, friends: parseInt(friendsCountResult.rows[0].count) },
      isFriend, friendshipStatus, friendshipId, isOwn: currentUserId === parseInt(id),
    })
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки профиля' })
  }
})

app.get('/api/users/:id/movies', authMiddleware, async (req, res) => {
  const { id } = req.params
  const currentUserId = req.user.id
  const { status } = req.query
  try {
    let query = `
      SELECT mv.kinopoisk_id AS "kinopoiskId", mv.name_ru AS "nameRu", mv.name_en AS "nameEn", mv.name_original AS "nameOriginal", mv.year, mv.poster_url_preview AS "posterUrlPreview", um_owner.status AS status, um_me.status AS my_status
      FROM user_movies um_owner LEFT JOIN movies mv ON mv.kinopoisk_id = um_owner.movie_id
      LEFT JOIN user_movies um_me ON um_me.movie_id = um_owner.movie_id AND um_me.user_id = $2
      WHERE um_owner.user_id = $1`
    const params = [id, currentUserId]
    if (status && status !== 'all') { query += ' AND um_owner.status = $3'; params.push(status) }
    query += ' ORDER BY um_owner.id DESC'
    const result = await pool.query(query, params)
    res.json({ movies: result.rows })
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки фильмов' })
  }
})

app.get('/api/users/:id/common', authMiddleware, async (req, res) => {
  const { id } = req.params
  if (req.user.id === parseInt(id)) return res.status(400).json({ error: 'Нельзя сравнить с собой' })
  try {
    const result = await pool.query(
      `SELECT mv.kinopoisk_id AS "kinopoiskId", mv.name_ru AS "nameRu", mv.name_en AS "nameEn", mv.name_original AS "nameOriginal", mv.year, mv.poster_url_preview AS "posterUrlPreview", u1.status AS my_status, u2.status AS their_status
       FROM user_movies u1 JOIN user_movies u2 ON u2.movie_id = u1.movie_id AND u2.user_id = $2
       LEFT JOIN movies mv ON mv.kinopoisk_id = u1.movie_id
       WHERE u1.user_id = $1 AND u1.status = 'want_to_watch' AND u2.status = 'want_to_watch' ORDER BY mv.year DESC`, [req.user.id, id]
    )
    res.json({ movies: result.rows })
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки общих фильмов' })
  }
})

// MATCH endpoints
app.post('/api/match/rooms', authMiddleware, async (req, res) => {
  const { friendIds, criterion } = req.body
  if (!friendIds || friendIds.length === 0) return res.status(400).json({ error: 'Выберите друга' })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const roomResult = await client.query(`INSERT INTO match_rooms (organizer_id, criterion, status, current_round) VALUES ($1, $2, 'waiting', 1) RETURNING *`, [req.user.id, criterion])
    const room = roomResult.rows[0]
    await client.query(`INSERT INTO match_participants (room_id, user_id, joined, responded) VALUES ($1, $2, TRUE, TRUE)`, [room.id, req.user.id])
    for (const friendId of friendIds) {
      await client.query(`INSERT INTO match_participants (room_id, user_id, joined, responded) VALUES ($1, $2, FALSE, FALSE)`, [room.id, friendId])
    }
    await client.query('COMMIT')
    const organizerResult = await pool.query('SELECT name FROM users WHERE id = $1', [req.user.id])
    for (const friendId of friendIds) {
      await createNotification(friendId, 'match_invite', `@${organizerResult.rows[0]?.name || 'Кто-то'} приглашает вас подобрать фильм`, '/match')
      const friendSocket = onlineUsers.get(friendId)
      if (friendSocket) io.to(friendSocket).emit('match:invite', { roomId: room.id, organizerName: organizerResult.rows[0]?.name })
    }
    res.json(room)
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: 'Ошибка' }) } finally { client.release() }
})

app.get('/api/match/rooms', authMiddleware, async (req, res) => {
  try {
    const invitationsResult = await pool.query(
      `SELECT r.id AS room_id, r.criterion, r.status, r.created_at, u.name AS organizer_name, u.id AS organizer_id
       FROM match_rooms r JOIN match_participants p ON p.room_id = r.id JOIN users u ON u.id = r.organizer_id
       WHERE p.user_id = $1 AND p.responded = FALSE AND r.status = 'waiting' ORDER BY r.created_at DESC`, [req.user.id]
    )
    res.json({ invitations: invitationsResult.rows })
  } catch (err) { res.status(500).json({ error: 'Ошибка' }) }
})

app.get('/api/match/rooms/:id/movies', authMiddleware, async (req, res) => {
  try {
    const roomResult = await pool.query('SELECT current_round FROM match_rooms WHERE id = $1', [req.params.id])
    if (roomResult.rows.length === 0) return res.status(404).json({ error: 'Комната не найдена' })
    const currentRound = roomResult.rows[0].current_round
    const result = await pool.query(
      `SELECT m.movie_id AS "kinopoiskId", mv.name_ru AS "nameRu", mv.name_en AS "nameEn", mv.name_original AS "nameOriginal", mv.year, mv.poster_url_preview AS "posterUrlPreview"
       FROM match_movies m LEFT JOIN movies mv ON mv.kinopoisk_id = m.movie_id WHERE m.room_id = $1 AND m.round = $2`, [req.params.id, currentRound]
    )
    res.json({ movies: result.rows, round: currentRound })
  } catch (err) { res.status(500).json({ error: 'Ошибка' }) }
})

app.get('/api/match/rooms/:id', authMiddleware, async (req, res) => {
  try {
    const roomResult = await pool.query(`SELECT r.*, u.name AS organizer_name FROM match_rooms r JOIN users u ON u.id = r.organizer_id WHERE r.id = $1`, [req.params.id])
    if (roomResult.rows.length === 0) return res.status(404).json({ error: 'Не найдена' })
    const participantsResult = await pool.query(
      `SELECT p.user_id AS id, u.name, p.joined, p.responded, p.declined, (p.user_id = r.organizer_id) AS is_organizer
       FROM match_participants p JOIN users u ON u.id = p.user_id JOIN match_rooms r ON r.id = p.room_id WHERE p.room_id = $1 ORDER BY is_organizer DESC`, [req.params.id]
    )
    res.json({ room: roomResult.rows[0], participants: participantsResult.rows })
  } catch (err) { res.status(500).json({ error: 'Ошибка' }) }
})

app.patch('/api/match/rooms/:id/respond', authMiddleware, async (req, res) => {
  const { accept } = req.body
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const updateResult = await client.query(`UPDATE match_participants SET responded = TRUE, declined = $1, joined = $2 WHERE room_id = $3 AND user_id = $4 RETURNING *`, [!accept, accept, req.params.id, req.user.id])
    if (updateResult.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Не найден' }) }
    if (!accept) {
      await client.query(`UPDATE match_rooms SET status = 'cancelled', cancelled_by = $1, cancelled_at = NOW() WHERE id = $2`, [req.user.id, req.params.id])
      const declinerResult = await client.query('SELECT name FROM users WHERE id = $1', [req.user.id])
      const roomResult = await client.query('SELECT organizer_id FROM match_rooms WHERE id = $1', [req.params.id])
      if (roomResult.rows[0]?.organizer_id !== req.user.id) {
        await createNotification(roomResult.rows[0].organizer_id, 'match_cancelled', `@${declinerResult.rows[0]?.name} отклонил приглашение`, '/match')
      }
    }
    await client.query('COMMIT')
    io.to(`match_room_${req.params.id}`).emit('match:updated', { roomId: req.params.id })
    res.json({ success: true, accepted: accept })
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: 'Ошибка' }) } finally { client.release() }
})

app.post('/api/match/rooms/:id/round', authMiddleware, async (req, res) => {
  try {
    const roomResult = await pool.query('SELECT * FROM match_rooms WHERE id = $1', [req.params.id])
    if (roomResult.rows.length === 0) return res.status(404).json({ error: 'Не найдена' })
    const room = roomResult.rows[0]
    if (room.organizer_id !== req.user.id) return res.status(403).json({ error: 'Только организатор' })
    if (room.status === 'cancelled') return res.status(400).json({ error: 'Закрыта' })

    if (room.current_round === 1) {
      const notResp = await pool.query('SELECT COUNT(*) FROM match_participants WHERE room_id = $1 AND responded = FALSE', [req.params.id])
      if (parseInt(notResp.rows[0].count) > 0) return res.status(400).json({ error: 'Не все приняли' })
    }

    const participantsResult = await pool.query('SELECT user_id FROM match_participants WHERE room_id = $1', [req.params.id])
    const participantIds = participantsResult.rows.map(p => p.user_id)
    let moviesQuery, params = []

    if (room.current_round === 1) {
      params.push(participantIds)
      switch (room.criterion) {
        case 'common_want': moviesQuery = `SELECT movie_id FROM user_movies WHERE user_id = ANY($1) AND status = 'want_to_watch' GROUP BY movie_id HAVING COUNT(DISTINCT user_id) = $2`; params.push(participantIds.length); break
        case 'common_all': moviesQuery = `SELECT movie_id FROM user_movies WHERE user_id = ANY($1) GROUP BY movie_id HAVING COUNT(DISTINCT user_id) = $2`; params.push(participantIds.length); break
        case 'all_want': moviesQuery = `SELECT DISTINCT movie_id FROM user_movies WHERE user_id = ANY($1) AND status = 'want_to_watch'`; break
        default: moviesQuery = `SELECT DISTINCT movie_id FROM user_movies WHERE user_id = ANY($1)`; break
      }
    } else {
      const prev = await pool.query(`SELECT movie_id FROM match_votes WHERE room_id = $1 AND round = $2 AND vote = 'yes' GROUP BY movie_id HAVING COUNT(DISTINCT user_id) = $3`, [req.params.id, room.current_round - 1, participantIds.length])
      const approvedIds = prev.rows.map(r => r.movie_id)
      if (approvedIds.length === 0) return res.json({ movies: [], round: room.current_round })
      for (const movieId of approvedIds) {
        await pool.query(`INSERT INTO match_movies (room_id, movie_id, round) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [req.params.id, movieId, room.current_round])
      }
      moviesQuery = `SELECT movie_id FROM match_movies WHERE room_id = $1 AND round = $2`
      params.push(req.params.id, room.current_round)
    }

    if (room.current_round === 1) {
      const moviesResult = await pool.query(moviesQuery, params)
      if (moviesResult.rows.length === 0) return res.json({ movies: [], round: 1 })
      for (const row of moviesResult.rows) {
        await pool.query(`INSERT INTO match_movies (room_id, movie_id, round) VALUES ($1, $2, 1) ON CONFLICT DO NOTHING`, [req.params.id, row.movie_id])
      }
    }

    await pool.query(`UPDATE match_rooms SET status = 'voting' WHERE id = $1`, [req.params.id])
    const moviesData = await pool.query(`SELECT m.movie_id AS "kinopoiskId", mv.name_ru AS "nameRu", mv.name_en AS "nameEn", mv.name_original AS "nameOriginal", mv.year, mv.poster_url_preview AS "posterUrlPreview" FROM match_movies m LEFT JOIN movies mv ON mv.kinopoisk_id = m.movie_id WHERE m.room_id = $1 AND m.round = $2`, [req.params.id, room.current_round])

    io.to(`match_room_${req.params.id}`).emit('match:round_started', { roomId: req.params.id, round: room.current_round })
    res.json({ movies: moviesData.rows, round: room.current_round })
  } catch (err) { res.status(500).json({ error: 'Ошибка' }) }
})

app.post('/api/match/rooms/:id/vote', authMiddleware, async (req, res) => {
  const { movieId, vote } = req.body
  if (!['yes', 'no'].includes(vote)) return res.status(400).json({ error: 'Неверный голос' })
  try {
    const roomResult = await pool.query('SELECT current_round FROM match_rooms WHERE id = $1', [req.params.id])
    const currentRound = roomResult.rows[0]?.current_round || 1
    await pool.query(
      `INSERT INTO match_votes (room_id, movie_id, user_id, vote, round) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (room_id, movie_id, user_id, round) DO UPDATE SET vote = EXCLUDED.vote`,
      [req.params.id, movieId, req.user.id, vote, currentRound]
    )
    io.to(`match_room_${req.params.id}`).emit('match:vote', { roomId: req.params.id, movieId, userId: req.user.id })
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: 'Ошибка' }) }
})

app.get('/api/match/rooms/:id/votes/:movieId', authMiddleware, async (req, res) => {
  try {
    const roomResult = await pool.query('SELECT current_round FROM match_rooms WHERE id = $1', [req.params.id])
    const currentRound = roomResult.rows[0]?.current_round || 1
    const result = await pool.query('SELECT COUNT(*) FROM match_participants WHERE room_id = $1', [req.params.id])
    const totalParticipants = parseInt(result.rows[0].count)
    const votes = await pool.query(`SELECT COUNT(DISTINCT user_id) FROM match_votes WHERE room_id = $1 AND movie_id = $2 AND round = $3`, [req.params.id, req.params.movieId, currentRound])
    const votedCount = parseInt(votes.rows[0].count)
    res.json({ allVoted: votedCount === totalParticipants, votedCount, totalParticipants })
  } catch (err) { res.status(500).json({ error: 'Ошибка' }) }
})

app.get('/api/match/rooms/:id/results', authMiddleware, async (req, res) => {
  try {
    const roomResult = await pool.query('SELECT current_round FROM match_rooms WHERE id = $1', [req.params.id])
    const currentRound = roomResult.rows[0]?.current_round || 1
    const participantsResult = await pool.query('SELECT COUNT(*) FROM match_participants WHERE room_id = $1', [req.params.id])
    const totalParticipants = parseInt(participantsResult.rows[0].count)
    const result = await pool.query(
      `SELECT m.movie_id AS "kinopoiskId", mv.name_ru AS "nameRu", mv.name_en AS "nameEn", mv.name_original AS "nameOriginal", mv.year, mv.poster_url_preview AS "posterUrlPreview"
       FROM match_movies m LEFT JOIN match_votes v ON v.room_id = m.room_id AND v.movie_id = m.movie_id AND v.round = $2
       LEFT JOIN movies mv ON mv.kinopoisk_id = m.movie_id WHERE m.room_id = $1 AND m.round = $2
       GROUP BY m.movie_id, mv.name_ru, mv.name_en, mv.name_original, mv.year, mv.poster_url_preview HAVING COUNT(CASE WHEN v.vote = 'yes' THEN 1 END) = $3`, [req.params.id, currentRound, totalParticipants]
    )
    res.json({ approved: result.rows, round: currentRound })
  } catch (err) { res.status(500).json({ error: 'Ошибка' }) }
})

app.post('/api/match/rooms/:id/next-round', authMiddleware, async (req, res) => {
  try {
    const roomResult = await pool.query('SELECT * FROM match_rooms WHERE id = $1', [req.params.id])
    const room = roomResult.rows[0]
    if (room.organizer_id !== req.user.id) return res.status(403).json({ error: 'Только организатор' })
    const newRound = room.current_round + 1
    const participantsResult = await pool.query('SELECT user_id FROM match_participants WHERE room_id = $1', [req.params.id])
    const approvedResult = await pool.query(`SELECT movie_id FROM match_votes WHERE room_id = $1 AND round = $2 AND vote = 'yes' GROUP BY movie_id HAVING COUNT(DISTINCT user_id) = $3`, [req.params.id, room.current_round, participantsResult.rows.length])
    const approvedIds = approvedResult.rows.map(r => r.movie_id)
    if (approvedIds.length === 0) return res.status(400).json({ error: 'Нет одобренных' })
    for (const movieId of approvedIds) {
      await pool.query(`INSERT INTO match_movies (room_id, movie_id, round) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [req.params.id, movieId, newRound])
    }
    await pool.query(`UPDATE match_rooms SET current_round = $1, status = 'voting' WHERE id = $2`, [newRound, req.params.id])
    const moviesData = await pool.query(`SELECT m.movie_id AS "kinopoiskId", mv.name_ru AS "nameRu", mv.name_en AS "nameEn", mv.name_original AS "nameOriginal", mv.year, mv.poster_url_preview AS "posterUrlPreview" FROM match_movies m LEFT JOIN movies mv ON mv.kinopoisk_id = m.movie_id WHERE m.room_id = $1 AND m.round = $2`, [req.params.id, newRound])
    io.to(`match_room_${req.params.id}`).emit('match:round_started', { roomId: req.params.id, round: newRound })
    res.json({ success: true, round: newRound, movies: moviesData.rows })
  } catch (err) { res.status(500).json({ error: 'Ошибка' }) }
})

app.patch('/api/match/rooms/:id/cancel', authMiddleware, async (req, res) => {
  try {
    const participant = await pool.query('SELECT * FROM match_participants WHERE room_id = $1 AND user_id = $2', [req.params.id, req.user.id])
    if (participant.rows.length === 0) return res.status(403).json({ error: 'Вы не участник' })
    await pool.query(`UPDATE match_rooms SET status = 'cancelled', cancelled_by = $1, cancelled_at = NOW() WHERE id = $2`, [req.user.id, req.params.id])
    const cancellerResult = await pool.query('SELECT name FROM users WHERE id = $1', [req.user.id])
    const others = await pool.query('SELECT user_id FROM match_participants WHERE room_id = $1 AND user_id != $2', [req.params.id, req.user.id])
    for (const p of others.rows) {
      await createNotification(p.user_id, 'match_cancelled', `@${cancellerResult.rows[0]?.name} отменил подбор`, '/match')
    }
    io.to(`match_room_${req.params.id}`).emit('match:cancelled', { roomId: req.params.id, cancelledByName: cancellerResult.rows[0]?.name })
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: 'Ошибка' }) }
})


// ───────────────────────── KINOPOISK PROXY ─────────────────────────

const KINOPOISK_BASE = 'https://kinopoiskapiunofficial.tech/api/v2.2/films/'
const KINOPOISK_SEARCH = 'https://kinopoiskapiunofficial.tech/api/v2.1/films/search-by-keyword?keyword='

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
    if (category === 'MARVEL') {
      const limit = parseInt(req.query.limit) || 20
      const offset = (page - 1) * limit
      let countQuery = 'SELECT COUNT(*) FROM main_movies mm JOIN movies m ON m.id = mm.movie_id'
      let dataQuery = `
        SELECT m.kinopoisk_id AS "kinopoiskId", m.name_ru AS "nameRu", m.name_en AS "nameEn", m.name_original AS "nameOriginal", m.year, m.type, m.poster_url AS "posterUrl", m.poster_url_preview AS "posterUrlPreview", m.rating_kinopoisk AS "ratingKinopoisk", m.rating_imdb AS "ratingImdb", m.description, m.film_length AS "filmLength", m.slogan, COALESCE(um.status, 'not_watched') AS status
        FROM main_movies mm JOIN movies m ON m.id = mm.movie_id LEFT JOIN user_movies um ON um.movie_id = m.kinopoisk_id AND um.user_id = $3`
      const params = [limit, offset, userId]
      let countParams = []
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
      return res.json({ items: result.rows, page, limit, total, totalPages: Math.ceil(total / limit), hasMore: offset + result.rows.length < total })
    }

    const response = await fetch(`https://kinopoiskapiunofficial.tech/api/v2.2/films/collections?type=${category}&page=${page}`, { headers: kinopoiskHeaders })
    if (!response.ok) return res.status(response.status).json({ error: 'Ошибка загрузки категории' })
    const data = await response.json()
    const films = data.items || []
    const filmIds = []
    for (const film of films) {
      await saveMovieToDb({
        kinopoiskId: film.kinopoiskId, nameRu: film.nameRu, nameEn: film.nameEn, nameOriginal: film.nameOriginal,
        year: film.year, type: film.type, posterUrl: film.posterUrl, posterUrlPreview: film.posterUrlPreview,
        ratingKinopoisk: film.ratingKinopoisk, ratingImdb: film.ratingImdb, description: film.description, filmLength: film.filmLength, slogan: film.slogan,
      })
      filmIds.push(film.kinopoiskId)
    }
    const statuses = {}
    if (filmIds.length > 0) {
      const statusResult = await pool.query('SELECT movie_id, status FROM user_movies WHERE user_id = $1 AND movie_id = ANY($2)', [userId, filmIds])
      statusResult.rows.forEach(row => statuses[row.movie_id] = row.status)
    }
    res.json({
      items: films.map(f => ({ ...f, kinopoisId: f.kinopoiskId, status: statuses[f.kinopoiskId] || 'not_watched' })),
      page, totalPages: data.totalPages || 1, hasMore: page < (data.totalPages || 1), total: data.total || 0
    })
  } catch (err) { res.status(500).json({ error: 'Ошибка загрузки фильмов' }) }
})

app.get('/api/kinopoisk/search', authMiddleware, async (req, res) => {
  const { keyword } = req.query
  if (!keyword) return res.status(400).json({ error: 'Нет ключевого слова' })
  try {
    const dbResult = await pool.query(
      `SELECT kinopoisk_id AS "kinopoiskId", name_ru AS "nameRu", name_en AS "nameEn", name_original AS "nameOriginal", year, type, poster_url_preview AS "posterUrlPreview"
       FROM movies WHERE LOWER(name_ru) LIKE LOWER($1) OR LOWER(name_en) LIKE LOWER($1) OR LOWER(name_original) LIKE LOWER($1) LIMIT 20`,
      [`%${keyword}%`]
    )
    const response = await fetch(`${KINOPOISK_SEARCH}${encodeURIComponent(keyword)}`, { headers: kinopoiskHeaders })
    const data = await response.json()
    const films = data.films || []
    for (const film of films) {
      await saveMovieToDb({
        kinopoiskId: film.filmId, nameRu: film.nameRu, nameEn: film.nameEn, nameOriginal: film.nameOriginal,
        year: film.year, type: film.type, posterUrl: film.posterUrl, posterUrlPreview: film.posterUrlPreview,
        ratingKinopoisk: film.rating, ratingImdb: film.ratingImdb, description: film.description, filmLength: film.filmLength, slogan: film.slogan,
      })
    }
    const combined = [...dbResult.rows]
    const dbIds = new Set(dbResult.rows.map(m => m.kinopoiskId))
    for (const film of films) {
      if (!dbIds.has(film.filmId)) {
        combined.push({ kinopoiskId: film.filmId, nameRu: film.nameRu, nameEn: film.nameEn, nameOriginal: film.nameOriginal, year: film.year, type: film.type, posterUrlPreview: film.posterUrlPreview })
      }
    }
    res.json({ films: combined })
  } catch (err) { res.status(500).json({ error: 'Ошибка поиска' }) }
})

app.get('/api/kinopoisk/:id/facts', authMiddleware, async (req, res) => {
  const { id } = req.params
  try {
    const dbResult = await pool.query('SELECT text FROM movie_facts WHERE movie_id = $1 ORDER BY id', [id])
    if (dbResult.rows.length > 0) return res.json({ items: dbResult.rows })
    const response = await fetch(`${KINOPOISK_BASE}${id}/facts`, { headers: kinopoiskHeaders })
    if (!response.ok) return res.status(response.status).json({ items: [] })
    const data = await response.json()
    const items = data.items || []
    for (const fact of items) {
      if (fact.text) await pool.query('INSERT INTO movie_facts (movie_id, text) VALUES ($1, $2)', [id, fact.text])
    }
    res.json({ items })
  } catch (err) { res.status(500).json({ error: 'Ошибка загрузки фактов' }) }
})

app.get('/api/kinopoisk/:id/relations', authMiddleware, async (req, res) => {
  const { id } = req.params
  try {
    const dbResult = await pool.query(
      `SELECT related_movie_id AS "kinopoiskId", relation_type AS "relationType", name_ru AS "nameRu", name_en AS "nameEn", name_original AS "nameOriginal", year, poster_url AS "posterUrl", poster_url_preview AS "posterUrlPreview"
       FROM movie_relations WHERE movie_id = $1 ORDER BY year ASC NULLS LAST`, [id]
    )
    if (dbResult.rows.length > 0) return res.json({ items: dbResult.rows })
    const response = await fetch(`${KINOPOISK_BASE}${id}/relations`, { headers: kinopoiskHeaders })
    if (!response.ok) return res.status(response.status).json({ items: [] })
    const data = await response.json()
    const items = data.items || []
    for (const item of items) {
      if (item.kinopoiskId) {
        await pool.query(
          `INSERT INTO movie_relations (movie_id, related_movie_id, relation_type, name_ru, name_en, name_original, year, poster_url, poster_url_preview) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
          [id, item.kinopoiskId, item.relationType, item.nameRu || null, item.nameEn || null, item.nameOriginal || null, item.year || null, item.posterUrl || null, item.posterUrlPreview || null]
        )
        if (item.nameRu || item.nameEn) await saveMovieToDb({ kinopoiskId: item.kinopoiskId, nameRu: item.nameRu, nameEn: item.nameEn, nameOriginal: item.nameOriginal, year: item.year, posterUrl: item.posterUrl, posterUrlPreview: item.posterUrlPreview })
      }
    }
    res.json({ items })
  } catch (err) { res.status(500).json({ error: 'Ошибка загрузки связей' }) }
})

app.get('/api/kinopoisk/:id/similars', authMiddleware, async (req, res) => {
  const { id } = req.params
  try {
    const dbResult = await pool.query(
      `SELECT related_movie_id AS "filmId", relation_type AS "relationType", name_ru AS "nameRu", name_en AS "nameEn", name_original AS "nameOriginal", year, poster_url AS "posterUrl", poster_url_preview AS "posterUrlPreview"
       FROM movie_relations WHERE movie_id = $1 AND relation_type = 'SIMILAR' ORDER BY year ASC NULLS LAST`, [id]
    )
    if (dbResult.rows.length > 0) return res.json({ items: dbResult.rows })
    const response = await fetch(`${KINOPOISK_BASE}${id}/similars`, { headers: kinopoiskHeaders })
    if (!response.ok) return res.status(response.status).json({ items: [] })
    const data = await response.json()
    const items = data.items || []
    for (const item of items) {
      if (item.filmId) {
        await pool.query(
          `INSERT INTO movie_relations (movie_id, related_movie_id, relation_type, name_ru, name_en, name_original, year, poster_url, poster_url_preview) VALUES ($1, $2, 'SIMILAR', $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
          [id, item.filmId, item.nameRu || null, item.nameEn || null, item.nameOriginal || null, item.year || null, item.posterUrl || null, item.posterUrlPreview || null]
        )
        if (item.nameRu || item.nameEn) await saveMovieToDb({ kinopoiskId: item.filmId, nameRu: item.nameRu, nameEn: item.nameEn, nameOriginal: item.nameOriginal, year: item.year, posterUrl: item.posterUrl, posterUrlPreview: item.posterUrlPreview })
      }
    }
    res.json({ items })
  } catch (err) { res.status(500).json({ error: 'Ошибка загрузки похожих' }) }
})

// КЛЮЧЕВОЙ ЭНДПОИНТ: Гибридное получение серий
app.get('/api/kinopoisk/:id/seasons', authMiddleware, async (req, res) => {
  const { id } = req.params
  const KINOPOISK_DEV_TOKEN = process.env.KINOPOISK_DEV_TOKEN

  try {
    // 1. Получаем данные из БД
    const movieRes = await pool.query('SELECT tmdb_id, type FROM movies WHERE kinopoisk_id = $1', [id])
    const movie = movieRes.rows[0]
    const kpEpisodesRes = await pool.query('SELECT season_number, episode_number, name_ru, release_date FROM seasons WHERE movie_id = $1', [id])

    let allEpisodes = kpEpisodesRes.rows

    // 2. Если есть TMDB ID, идем в TMDB за дополнением
    if (movie && movie.tmdb_id && movie.type !== 'FILM') {
      const tmdbEpisodes = await getTmdbEpisodes(movie.tmdb_id, id)

      const map = new Map()
      // Сначала кидаем Кинопоиск
      allEpisodes.forEach(e => map.set(`${e.season_number}-${e.episode_number}`, { ...e, source: 'kp' }))

      // Дополняем TMDB
      tmdbEpisodes.forEach(e => {
        const key = `${e.season_number}-${e.episode_number}`
        const existing = map.get(key)
        if (!existing) {
          map.set(key, {
            season_number: e.season_number,
            episode_number: e.episode_number,
            name_ru: e.name_ru,
            release_date: e.air_date,
            source: 'tmdb'
          })
        } else {
          if (!existing.name_ru || existing.name_ru === '—') existing.name_ru = e.name_ru
          if (!existing.release_date) existing.release_date = e.air_date
        }
      })

      allEpisodes = Array.from(map.values())
    }

    // 3. Если Кинопоиск вообще ничего не дал (пустая таблица seasons), пробуем kinopoisk.dev
    if (allEpisodes.length === 0 && KINOPOISK_DEV_TOKEN) {
      const url = `https://api.kinopoisk.dev/v1.4/season?movieId=${id}&limit=250`
      const response = await fetch(url, { headers: { 'X-API-KEY': KINOPOISK_DEV_TOKEN, 'Content-Type': 'application/json' } })

      if (response.ok) {
        const data = await response.json()
        for (const season of data.docs || []) {
          if (season.number == null) continue
          for (const ep of season.episodes || []) {
            const epNum = ep.episodeNumber ?? ep.number ?? ep.episode
            if (epNum == null) continue

            const newEp = {
              season_number: season.number,
              episode_number: epNum,
              name_ru: ep.name || ep.nameRu,
              release_date: ep.airDate || ep.releaseDate,
            }
            allEpisodes.push(newEp)

            // Сохраняем в БД на будущее
            await pool.query(
              `INSERT INTO seasons (movie_id, season_number, episode_number, name_ru, release_date) VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (movie_id, season_number, episode_number) DO UPDATE SET name_ru = COALESCE(EXCLUDED.name_ru, seasons.name_ru), release_date = COALESCE(EXCLUDED.release_date, seasons.release_date)`,
              [id, newEp.season_number, newEp.episode_number, newEp.name_ru, newEp.release_date]
            )
          }
        }
      }
    }

    // Сортируем по сезону и серии
    allEpisodes.sort((a, b) => a.season_number - b.season_number || a.episode_number - b.episode_number)

    res.json({ episodes: allEpisodes })
  } catch (err) {
    console.error('Ошибка загрузки сезонов:', err)
    res.status(500).json({ error: 'Ошибка загрузки сезонов' })
  }
})

app.get('/api/kinopoisk/:id', authMiddleware, async (req, res) => {
  const { id } = req.params
  try {
    let result = await pool.query(
      `SELECT kinopoisk_id AS "kinopoiskId", name_ru AS "nameRu", name_en AS "nameEn", name_original AS "nameOriginal", year, type, poster_url AS "posterUrl", poster_url_preview AS "posterUrlPreview", rating_kinopoisk AS "ratingKinopoisk", rating_imdb AS "ratingImdb", description, film_length AS "filmLength", slogan
       FROM movies WHERE kinopoisk_id = $1`, [id]
    )

    if (result.rows.length === 0) {
      const response = await fetch(`${KINOPOISK_BASE}${id}`, { headers: kinopoiskHeaders })
      if (!response.ok) return res.status(response.status).json({ error: 'Фильм не найден' })
      const movie = await response.json()
      await saveMovieToDb(movie)
      return res.json(movie)
    }

    const row = result.rows[0]
    const hasNulls = Object.values(row).some((val) => val === null)

    if (hasNulls) {
      console.log(`🔄 Найдены NULL в данных для фильма ${id}. Запускаю обновление...`)
      await updateOneMovie(id)
      result = await pool.query(
        `SELECT kinopoisk_id AS "kinopoiskId", name_ru AS "nameRu", name_en AS "nameEn", name_original AS "nameOriginal", year, type, poster_url AS "posterUrl", poster_url_preview AS "posterUrlPreview", rating_kinopoisk AS "ratingKinopoisk", rating_imdb AS "ratingImdb", description, film_length AS "filmLength", slogan
         FROM movies WHERE kinopoisk_id = $1`, [id]
      )
    }

    const movie = result.rows[0]
    const genresResult = await pool.query('SELECT genre FROM movie_genres WHERE movie_id = $1 ORDER BY id', [id])
    const countriesResult = await pool.query('SELECT country FROM movie_countries WHERE movie_id = $1 ORDER BY id', [id])

    if (genresResult.rows.length === 0 || countriesResult.rows.length === 0) {
      try {
        const response = await fetch(`${KINOPOISK_BASE}${id}`, { headers: kinopoiskHeaders })
        if (response.ok) {
          const apiMovie = await response.json()
          if (apiMovie.genres) for (const g of apiMovie.genres) await pool.query(`INSERT INTO movie_genres (movie_id, genre) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, g.genre])
          if (apiMovie.countries) for (const c of apiMovie.countries) await pool.query(`INSERT INTO movie_countries (movie_id, country) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, c.country])
          movie.genres = (await pool.query('SELECT genre FROM movie_genres WHERE movie_id = $1', [id])).rows
          movie.countries = (await pool.query('SELECT country FROM movie_countries WHERE movie_id = $1', [id])).rows
        }
      } catch (err) { movie.genres = []; movie.countries = [] }
    } else {
      movie.genres = genresResult.rows
      movie.countries = countriesResult.rows
    }
    res.json(movie)
  } catch (err) { res.status(500).json({ error: 'Ошибка загрузки фильма' }) }
})

// ───────────────────────── BACKGROUND UPDATE ─────────────────────────

const { logUpdate, logSessionStart, logError, logWarning } = require('./logger')

const UPDATE_DELAY_MS = 300

const FIELD_MAP = {
  name_ru: 'nameRu', name_en: 'nameEn', name_original: 'nameOriginal', year: 'year', type: 'type',
  poster_url: 'posterUrl', poster_url_preview: 'posterUrlPreview', rating_kinopoisk: 'ratingKinopoisk',
  rating_imdb: 'ratingImdb', description: 'description', film_length: 'filmLength', slogan: 'slogan',
}

const NUMERIC_FIELDS = new Set(['year', 'rating_kinopoisk', 'rating_imdb', 'film_length'])

function normalizeForCompare(value, field) {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isNaN(value) ? null : value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '' || trimmed === 'null') return null
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
    const response = await fetch(url, { headers: { 'X-API-KEY': KINOPOISK_DEV_TOKEN, 'Content-Type': 'application/json' } })
    if (!response.ok) return { changed: 0, error: `HTTP ${response.status}` }

    const data = await response.json()
    const allEpisodes = []

    for (const season of data.docs || []) {
      if (season.number == null) continue
      for (const ep of season.episodes || []) {
        const epNum = ep.episodeNumber ?? ep.number ?? ep.episode
        if (epNum == null) continue

        allEpisodes.push({
          season_number: season.number, episode_number: epNum,
          name_ru: ep.name || ep.nameRu, release_date: ep.airDate || ep.releaseDate,
        })
      }
    }

    let changedCount = 0
    for (const ep of allEpisodes) {
      const existing = await pool.query('SELECT name_ru, release_date FROM seasons WHERE movie_id = $1 AND season_number = $2 AND episode_number = $3', [kinopoiskId, ep.season_number, ep.episode_number])
      if (existing.rows.length > 0) {
        const oldEp = existing.rows[0]
        const oldDate = oldEp.release_date ? new Date(oldEp.release_date).toISOString().split('T')[0] : null
        const newDate = ep.release_date ? new Date(ep.release_date).toISOString().split('T')[0] : null
        if (oldEp.name_ru !== ep.name_ru || oldDate !== newDate) {
          await pool.query(`UPDATE seasons SET name_ru = $1, release_date = $2 WHERE movie_id = $3 AND season_number = $4 AND episode_number = $5`, [ep.name_ru, ep.release_date, kinopoiskId, ep.season_number, ep.episode_number])
          changedCount++
        }
      } else {
        await pool.query(`INSERT INTO seasons (movie_id, season_number, episode_number, name_ru, release_date) VALUES ($1, $2, $3, $4, $5)`, [kinopoiskId, ep.season_number, ep.episode_number, ep.name_ru, ep.release_date])
        changedCount++
      }
    }
    return { changed: changedCount, error: null }
  } catch (err) { return { changed: 0, error: err.message } }
}

async function updateOneMovie(kinopoiskId) {
  const currentResult = await pool.query(`SELECT name_ru, name_en, name_original, year, type, poster_url, poster_url_preview, rating_kinopoisk, rating_imdb, description, film_length, slogan FROM movies WHERE kinopoisk_id = $1`, [kinopoiskId])
  if (currentResult.rows.length === 0) return { changed: [], error: 'not_in_db' }

  const current = currentResult.rows[0]
  const res = await fetch(`${KINOPOISK_BASE}${kinopoiskId}`, { headers: kinopoiskHeaders })
  if (!res.ok) return { changed: [], error: `HTTP ${res.status}` }
  const fresh = await res.json()

  const changed = []
  const updateValues = {}
  for (const [dbField, apiField] of Object.entries(FIELD_MAP)) {
    const oldNorm = normalizeForCompare(current[dbField], dbField)
    const newRaw = fresh[apiField]
    const newNorm = normalizeForCompare(newRaw, dbField)
    if (newNorm === null) {
      if (oldNorm === 0 || oldNorm === '—') continue
      if (oldNorm === null) {
        const fallback = NUMERIC_FIELDS.has(dbField) ? 0 : '—'
        changed.push({ field: dbField, old: null, new: fallback })
        updateValues[dbField] = fallback
        continue
      }
      continue
    }
    if (oldNorm === newNorm) continue
    if (oldNorm === 0 || oldNorm === '—') {
      changed.push({ field: dbField, old: oldNorm, new: newNorm })
      updateValues[dbField] = newRaw ?? null
      continue
    }
    changed.push({ field: dbField, old: oldNorm, new: newNorm })
    updateValues[dbField] = newRaw ?? null
  }

  const currentGenresResult = await pool.query('SELECT genre FROM movie_genres WHERE movie_id = $1 ORDER BY genre', [kinopoiskId])
  const currentGenres = currentGenresResult.rows.map(r => r.genre).sort()
  const freshGenres = (fresh.genres || []).map(g => g.genre).filter(Boolean).sort()
  const genresChanged = currentGenres.length !== freshGenres.length || currentGenres.some((g, i) => g !== freshGenres[i])
  if (genresChanged && freshGenres.length > 0) changed.push({ field: 'genres', old: currentGenres.join(', '), new: freshGenres.join(', ') })

  const currentCountriesResult = await pool.query('SELECT country FROM movie_countries WHERE movie_id = $1 ORDER BY country', [kinopoiskId])
  const currentCountries = currentCountriesResult.rows.map(r => r.country).sort()
  const freshCountries = (fresh.countries || []).map(c => c.country).filter(Boolean).sort()
  const countriesChanged = currentCountries.length !== freshCountries.length || currentCountries.some((c, i) => c !== freshCountries[i])
  if (countriesChanged && freshCountries.length > 0) changed.push({ field: 'countries', old: currentCountries.join(', '), new: freshCountries.join(', ') })

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
    await pool.query(`UPDATE movies SET ${setClauses.join(', ')} WHERE kinopoisk_id = $1`, values)
  }

  if (genresChanged && freshGenres.length > 0) {
    await pool.query('DELETE FROM movie_genres WHERE movie_id = $1', [kinopoiskId])
    await pool.query(`INSERT INTO movie_genres (movie_id, genre) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`, [kinopoiskId, freshGenres])
  }
  if (countriesChanged && freshCountries.length > 0) {
    await pool.query('DELETE FROM movie_countries WHERE movie_id = $1', [kinopoiskId])
    await pool.query(`INSERT INTO movie_countries (movie_id, country) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`, [kinopoiskId, freshCountries])
  }

  await pool.query(`UPDATE movies SET last_checked_at = NOW() WHERE kinopoisk_id = $1`, [kinopoiskId])

  if (fresh.type === 'TV_SERIES' || fresh.type === 'MINI_SERIES') {
    const seasonsResult = await updateSeasonsForMovie(kinopoiskId)
    if (seasonsResult.error) {
      if (seasonsResult.error.startsWith('HTTP') && (seasonsResult.error === 'HTTP 402' || seasonsResult.error === 'HTTP 429')) return { changed, error: seasonsResult.error }
    } else if (seasonsResult.changed > 0) {
      changed.push({ field: 'seasons', old: '-', new: `Обновлено серий: ${seasonsResult.changed}` })
    }
  }
  return { changed, error: null }
}

async function updateOldMovies(batchSize = 100) {
  logUpdate(`Проверяю фильмы для обновления... (батч: ${batchSize})`)
  try {
    const result = await pool.query(`SELECT kinopoisk_id FROM movies ORDER BY COALESCE(last_checked_at, updated_at, created_at) ASC LIMIT $1`, [batchSize])
    if (result.rows.length === 0) { logWarning('Нет фильмов для обновления'); return }
    logSessionStart(result.rows.length)
    let success = 0, failed = 0, unchanged = 0, stopped = false, processedIds = []

    for (const row of result.rows) {
      try {
        const { changed, error } = await updateOneMovie(row.kinopoisk_id)
        if (error === 'not_in_db') { logWarning(`Фильм ${row.kinopoisk_id} не найден в БД`); failed++; continue }
        if (error && error.startsWith('HTTP')) {
          if (error === 'HTTP 402' || error === 'HTTP 429') { logWarning('Лимит API исчерпан — прерываю обновление'); stopped = true; break }
          logError(row.kinopoisk_id, error); failed++; continue
        }
        if (error) { logError(row.kinopoisk_id, error); failed++; continue }
        processedIds.push(row.kinopoisk_id)
        if (changed.length === 0) { unchanged++; logUpdate(`  ○ ${row.kinopoisk_id} — без изменений`) }
        else { success++; const changesText = changed.map(c => `${c.field}: "${c.old}" → "${c.new}"`).join(', '); logUpdate(`  ✓ ${row.kinopoisk_id} — обновлено: ${changesText}`) }
      } catch (err) { failed++; logError(row.kinopoisk_id, err.message) }
      await new Promise(r => setTimeout(r, UPDATE_DELAY_MS))
    }

    if (processedIds.length > 0) {
      await pool.query(`UPDATE movies SET last_checked_at_all = NOW() WHERE kinopoisk_id = ANY($1)`, [processedIds])
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
  } catch (err) { logError('session', err.message) }
}

async function checkAndUpdateOnStartup() {
  try {
    const result = await pool.query(
      `SELECT MAX(last_checked_at_all) as last_full_update FROM movies`
    )
    const lastFullUpdate = result.rows[0]?.last_full_update
    const now = new Date()

    let shouldUpdate = false
    let batchSize = 300

    if (!lastFullUpdate) {
      console.log('🕒 Глобальное обновление никогда не запускалось. Запускаю (батч: 300)...')
      shouldUpdate = true
    } else {
      const lastTime = new Date(lastFullUpdate).getTime()
      const nowTime = now.getTime()

      if (nowTime < lastTime) {
        console.log('🕒 Время из БД в будущем. Запускаю (батч: 300)...')
        shouldUpdate = true
      } else {
        const diffHours = (nowTime - lastTime) / (1000 * 60 * 60)
        if (diffHours > 1) {
          batchSize = Math.min(300, Math.max(1, Math.floor(diffHours * 18.75)))
          console.log(`🕒 Прошло ${diffHours.toFixed(1)} ч. Запускаю обновление (батч: ${batchSize})...`)
          shouldUpdate = true
        } else {
          console.log(`🕒 Глобальное обновление было ${diffHours.toFixed(1)} ч. назад (меньше 1). Пропускаю.`)
        }
      }
    }

    if (shouldUpdate) {
      // 1. Сначала обновляем данные из Кинопоиска (в т.ч. заполняем NULL-имена)
      await updateOldMovies(batchSize)
      // 2. Потом догоняем TMDB ID для тех, у кого их ещё нет
      await syncMissingTmdbIds()
    }
  } catch (err) {
    console.error('Ошибка проверки времени обновления:', err)
  }
}

setTimeout(checkAndUpdateOnStartup, 7500)

httpServer.listen(process.env.PORT, () => {
  console.log(`Сервер запущен на порту ${process.env.PORT}`)
})