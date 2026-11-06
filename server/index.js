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
const IMAGE_BASE = 'https://image.tmdb.org/t/p/'

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
          `SELECT id, status FROM match_rooms WHERE id = $1`, [roomId]
        )
        if (roomResult.rows.length === 0) continue
        if (roomResult.rows[0].status === 'cancelled') continue

        setTimeout(async () => {
          try {
            const checkUser = await pool.query(
              `SELECT * FROM match_participants WHERE room_id = $1 AND user_id = $2`,
              [roomId, userId]
            )
            if (checkUser.rows.length === 0) return
            if (onlineUsers.has(userId)) return

            await pool.query(
              `UPDATE match_rooms SET status = 'cancelled', cancelled_by = $1, cancelled_at = NOW() WHERE id = $2 AND status != 'cancelled'`,
              [userId, roomId]
            )
            io.to(`match_room_${roomId}`).emit('match:cancelled', {
              roomId, cancelledByName: socket.userName, reason: 'disconnect',
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

// ───────────────────────── TMDB HELPERS ─────────────────────────

async function tmdbFetch(url, retries = 2) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TMDB_TOKEN}` },
  })

  if (res.status === 429 && retries > 0) {
    const retryAfter = parseInt(res.headers.get('retry-after') || '10')
    console.log(`  ⏸️ Rate limit TMDB, ждём ${retryAfter}s...`)
    await new Promise(r => setTimeout(r, retryAfter * 1000))
    return tmdbFetch(url, retries - 1)
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`TMDB HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  return res.json()
}

/**
 * Проверяет, сериал это или фильм. Кэширует результат в БД.
 */
async function detectTmdbType(tmdbId) {
  // Проверяем в БД
  const existing = await pool.query('SELECT type FROM movies WHERE tmdb_id = $1', [tmdbId])
  if (existing.rows.length > 0 && existing.rows[0].type) {
    return existing.rows[0].type
  }

  // Пробуем tv, потом movie
  try {
    const tv = await tmdbFetch(`${TMDB_BASE}/tv/${tmdbId}?language=ru-RU`)
    return 'TV_SERIES'
  } catch {
    return 'FILM'
  }
}

/**
 * Загружает/обновляет фильм или сериал из TMDB в БД.
 */
async function upsertTmdbMovie(tmdbId) {
  const type = await detectTmdbType(tmdbId)
  const isTV = type === 'TV_SERIES' || type === 'MINI_SERIES'
  const endpoint = isTV ? 'tv' : 'movie'

  const data = await tmdbFetch(
    `${TMDB_BASE}/${endpoint}/${tmdbId}?language=ru-RU&append_to_response=external_ids`
  )

  const title = data.title || data.name || '—'
  const originalTitle = data.original_title || data.original_name || '—'
  const year = parseInt((data.release_date || data.first_air_date || '').slice(0, 4)) || 0
  const posterUrl = data.poster_path ? `${IMAGE_BASE}w500${data.poster_path}` : '—'
  const posterPreview = data.poster_path ? `${IMAGE_BASE}w200${data.poster_path}` : '—'
  const rating = data.vote_average || 0
  const description = data.overview || '—'
  const filmLength = isTV ? (data.episode_run_time?.[0] || 0) : (data.runtime || 0)
  const slogan = data.tagline || '—'
  const imdbId = data.external_ids?.imdb_id || null

  await pool.query(`
    INSERT INTO movies (tmdb_id, name_ru, name_en, name_original, year, type, poster_url, poster_url_preview, rating_imdb, description, film_length, slogan, imdb_id, tmdb_last_synced_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
    ON CONFLICT (tmdb_id) DO UPDATE SET
      name_ru = EXCLUDED.name_ru,
      name_en = EXCLUDED.name_en,
      name_original = EXCLUDED.name_original,
      year = EXCLUDED.year,
      type = EXCLUDED.type,
      poster_url = EXCLUDED.poster_url,
      poster_url_preview = EXCLUDED.poster_url_preview,
      rating_imdb = EXCLUDED.rating_imdb,
      description = EXCLUDED.description,
      film_length = EXCLUDED.film_length,
      slogan = EXCLUDED.slogan,
      imdb_id = COALESCE(EXCLUDED.imdb_id, movies.imdb_id),
      tmdb_last_synced_at = NOW()
  `, [tmdbId, title, originalTitle, originalTitle, year, type, posterUrl, posterPreview, rating, description, filmLength, slogan, imdbId])

  // Жанры
  await pool.query('DELETE FROM movie_genres WHERE movie_id = $1', [tmdbId])
  for (const g of data.genres || []) {
    await pool.query(
      'INSERT INTO movie_genres (movie_id, genre) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [tmdbId, g.name]
    )
  }

  // Страны
  await pool.query('DELETE FROM movie_countries WHERE movie_id = $1', [tmdbId])
  for (const c of data.production_countries || []) {
    await pool.query(
      'INSERT INTO movie_countries (movie_id, country) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [tmdbId, c.name]
    )
  }

  // Для сериалов — сезоны и эпизоды
  if (isTV && data.seasons) {
    await syncTmdbSeasons(tmdbId, data.seasons)
  }

  return { tmdbId, type, isTV }
}

/**
 * Синхронизирует сезоны и эпизоды в tmdb_episodes.
 */
async function syncTmdbSeasons(tmdbId, seasons) {
  const validSeasons = (seasons || []).filter(s => s.season_number > 0)

  for (const season of validSeasons) {
    try {
      const seasonData = await tmdbFetch(
        `${TMDB_BASE}/tv/${tmdbId}/season/${season.season_number}?language=ru-RU`
      )
      for (const ep of seasonData.episodes || []) {
        if (ep.episode_number == null) continue
        await pool.query(
          `INSERT INTO tmdb_episodes (movie_id, season_number, episode_number, name_ru, air_date, overview, tmdb_episode_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (movie_id, season_number, episode_number) DO UPDATE SET
             name_ru = EXCLUDED.name_ru,
             air_date = EXCLUDED.air_date,
             overview = EXCLUDED.overview`,
          [tmdbId, ep.season_number, ep.episode_number, ep.name || null, ep.air_date || null, ep.overview || null, ep.id]
        )
      }
    } catch (err) {
      console.error(`Ошибка сезона ${season.season_number} для ${tmdbId}:`, err.message)
    }
  }
}

/**
 * Получает эпизоды из БД (с проверкой актуальности).
 */
async function getEpisodesFromDb(tmdbId) {
  const movie = await pool.query('SELECT type, tmdb_last_synced_at FROM movies WHERE tmdb_id = $1', [tmdbId])
  if (movie.rows.length === 0) return []

  const isTV = movie.rows[0].type === 'TV_SERIES' || movie.rows[0].type === 'MINI_SERIES'
  if (!isTV) return []

  // Проверяем свежесть (7 дней)
  const lastSync = movie.rows[0].tmdb_last_synced_at
  const needsRefresh = !lastSync || (Date.now() - new Date(lastSync).getTime()) > 7 * 24 * 60 * 60 * 1000

  const existing = await pool.query(
    'SELECT season_number, episode_number, name_ru, air_date as release_date FROM tmdb_episodes WHERE movie_id = $1 ORDER BY season_number, episode_number',
    [tmdbId]
  )

  if (existing.rows.length === 0 || needsRefresh) {
    try {
      await upsertTmdbMovie(tmdbId)
      const fresh = await pool.query(
        'SELECT season_number, episode_number, name_ru, air_date as release_date FROM tmdb_episodes WHERE movie_id = $1 ORDER BY season_number, episode_number',
        [tmdbId]
      )
      return fresh.rows
    } catch (err) {
      console.error(`Ошибка обновления ${tmdbId}:`, err.message)
      return existing.rows
    }
  }

  return existing.rows
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

// ───────────────────────── IMPORT ─────────────────────────

app.post('/api/import/upload', authMiddleware, upload.single('file'), async (req, res) => {
  const userId = req.user.id
  const file = req.file
  const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN
  const CHAT_ID = process.env.TELEGRAM_CHAT_ID

  if (!file) return res.status(400).json({ error: 'Файл не загружен' })
  const ext = file.originalname.split('.').pop().toLowerCase()
  if (ext !== 'xlsx') return res.status(400).json({ error: 'Поддерживается только .xlsx' })

  const magicBytes = file.buffer.slice(0, 4).toString('hex').toUpperCase()
  if (magicBytes !== '504B0304') return res.status(400).json({ error: 'Файл поврежден' })

  if (!TELEGRAM_TOKEN || !CHAT_ID) return res.status(500).json({ error: 'Telegram не настроен' })

  try {
    const formData = new FormData()
    formData.append('chat_id', CHAT_ID)
    formData.append('caption', `Новый импорт фильмов от пользователя #${userId}`)
    const blob = new Blob([file.buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    formData.append('document', blob, file.originalname)

    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendDocument`, {
      method: 'POST', body: formData,
    })
    const data = await response.json()
    if (!data.ok) throw new Error(data.description || 'Ошибка Telegram API')
    res.json({ success: true, message: 'Файл отправлен' })
  } catch (err) {
    res.status(500).json({ error: 'Не удалось отправить файл.' })
  }
})

// ───────────────────────── MAIN / SEARCH (TMDB) ─────────────────────────

app.get('/api/kinopoisk/main', authMiddleware, async (req, res) => {
  const page = parseInt(req.query.page) || 1
  const category = req.query.category || 'MARVEL'
  const typeFilter = req.query.type || 'ALL'
  const userId = req.user.id

  try {
    // MARVEL — кастомная подборка из main_movies
    if (category === 'MARVEL') {
      const limit = parseInt(req.query.limit) || 20
      const offset = (page - 1) * limit
      let countQuery = 'SELECT COUNT(*) FROM main_movies mm JOIN movies m ON m.id = mm.movie_id'
      let dataQuery = `
        SELECT m.tmdb_id AS "kinopoiskId", m.tmdb_id AS "tmdbId", m.name_ru AS "nameRu", m.name_en AS "nameEn", m.name_original AS "nameOriginal",
          m.year, m.type, m.poster_url AS "posterUrl", m.poster_url_preview AS "posterUrlPreview",
          m.rating_imdb AS "ratingKinopoisk", m.rating_imdb AS "ratingImdb", m.description,
          m.film_length AS "filmLength", m.slogan,
          COALESCE(um.status, 'not_watched') AS status
        FROM main_movies mm JOIN movies m ON m.id = mm.movie_id
        LEFT JOIN user_movies um ON um.movie_id = m.tmdb_id AND um.user_id = $3`
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
      return res.json({
        items: result.rows, page, limit, total,
        totalPages: Math.ceil(total / limit),
        hasMore: offset + result.rows.length < total,
      })
    }

    // Остальные категории — TMDB
    let endpoint
    switch (category) {
      case 'TOP_POPULAR_ALL': endpoint = '/trending/all/week'; break
      case 'TOP_POPULAR_MOVIES': endpoint = '/movie/popular'; break
      case 'POPULAR_SERIES': endpoint = '/tv/popular'; break
      case 'TOP_250_TV_SHOWS': endpoint = '/tv/top_rated'; break
      case 'TOP_250_MOVIES': endpoint = '/movie/top_rated'; break
      default: endpoint = '/movie/popular'
    }

    const data = await tmdbFetch(
      `${TMDB_BASE}${endpoint}?page=${page}&language=ru-RU`
    )
    let items = data.results || []

    if (typeFilter !== 'ALL') {
      items = items.filter(item => {
        const itemType = item.media_type === 'tv' ? 'TV_SERIES' : 'FILM'
        return itemType === typeFilter || (typeFilter === 'MINI_SERIES' && itemType === 'TV_SERIES')
      })
    }

    const tmdbIds = items.map(i => i.id).filter(Boolean)
    const statuses = {}
    if (tmdbIds.length > 0) {
      const statusResult = await pool.query(
        'SELECT movie_id, status FROM user_movies WHERE user_id = $1 AND movie_id = ANY($2)',
        [userId, tmdbIds]
      )
      statusResult.rows.forEach(row => { statuses[row.movie_id] = row.status })
    }

    const responseItems = items.map(item => {
      const isTV = item.media_type === 'tv' || item.first_air_date
      return {
        kinopoiskId: item.id,
        tmdbId: item.id,
        nameRu: item.title || item.name || '—',
        nameEn: item.original_title || item.original_name || '—',
        nameOriginal: item.original_title || item.original_name || '—',
        year: parseInt((item.release_date || item.first_air_date || '').slice(0, 4)) || 0,
        type: isTV ? 'TV_SERIES' : 'FILM',
        posterUrl: item.poster_path ? `${IMAGE_BASE}w500${item.poster_path}` : null,
        posterUrlPreview: item.poster_path ? `${IMAGE_BASE}w200${item.poster_path}` : null,
        ratingKinopoisk: item.vote_average || 0,
        ratingImdb: item.vote_average || 0,
        description: item.overview || '—',
        status: statuses[item.id] || 'not_watched',
      }
    })

    res.json({
      items: responseItems, page,
      totalPages: data.total_pages || 1,
      hasMore: page < (data.total_pages || 1),
      total: data.total_results || 0,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка загрузки' })
  }
})

app.get('/api/kinopoisk/search', authMiddleware, async (req, res) => {
  const { keyword } = req.query
  if (!keyword) return res.status(400).json({ error: 'Нет ключевого слова' })

  try {
    const data = await tmdbFetch(
      `${TMDB_BASE}/search/multi?query=${encodeURIComponent(keyword)}&language=ru-RU&include_adult=false`
    )

    const films = (data.results || [])
      .filter(item => item.media_type === 'movie' || item.media_type === 'tv')
      .map(item => {
        const isTV = item.media_type === 'tv'
        return {
          kinopoiskId: item.id,
          tmdbId: item.id,
          nameRu: item.title || item.name || '—',
          nameEn: item.original_title || item.original_name || '—',
          nameOriginal: item.original_title || item.original_name || '—',
          year: parseInt((item.release_date || item.first_air_date || '').slice(0, 4)) || 0,
          type: isTV ? 'TV_SERIES' : 'FILM',
          posterUrlPreview: item.poster_path ? `${IMAGE_BASE}w200${item.poster_path}` : null,
        }
      })

    res.json({ films })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка поиска' })
  }
})

// ───────────────────────── MOVIE DETAIL (TMDB) ─────────────────────────

app.get('/api/kinopoisk/:id', authMiddleware, async (req, res) => {
  const tmdbId = parseInt(req.params.id)
  if (!tmdbId) return res.status(400).json({ error: 'Неверный ID' })

  try {
    // Всегда загружаем из TMDB (свежие данные)
    try {
      await upsertTmdbMovie(tmdbId)
    } catch (err) {
      console.error(`Ошибка загрузки ${tmdbId} из TMDB:`, err.message)
    }

    const movieRes = await pool.query('SELECT * FROM movies WHERE tmdb_id = $1', [tmdbId])
    if (movieRes.rows.length === 0) return res.status(404).json({ error: 'Фильм не найден' })

    const movie = movieRes.rows[0]
    const genres = await pool.query('SELECT genre FROM movie_genres WHERE movie_id = $1', [tmdbId])
    const countries = await pool.query('SELECT country FROM movie_countries WHERE movie_id = $1', [tmdbId])

    res.json({
      kinopoiskId: movie.tmdb_id,
      tmdbId: movie.tmdb_id,
      nameRu: movie.name_ru,
      nameEn: movie.name_en,
      nameOriginal: movie.name_original,
      year: movie.year,
      type: movie.type,
      posterUrl: movie.poster_url,
      posterUrlPreview: movie.poster_url_preview,
      ratingKinopoisk: movie.rating_imdb,
      ratingImdb: movie.rating_imdb,
      description: movie.description,
      filmLength: movie.film_length,
      slogan: movie.slogan,
      genres: genres.rows,
      countries: countries.rows,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка загрузки фильма' })
  }
})

// ───────────────────────── FACTS / RELATIONS / SIMILARS ─────────────────────────

app.get('/api/kinopoisk/:id/facts', authMiddleware, (req, res) => {
  // У TMDB нет фактов — возвращаем пустой массив
  res.json({ items: [] })
})

app.get('/api/kinopoisk/:id/relations', authMiddleware, async (req, res) => {
  const tmdbId = parseInt(req.params.id)
  try {
    const result = await pool.query(
      `SELECT related_movie_id AS "kinopoiskId", relation_type AS "relationType",
         name_ru AS "nameRu", name_en AS "nameEn", name_original AS "nameOriginal",
         year, poster_url AS "posterUrl", poster_url_preview AS "posterUrlPreview"
       FROM movie_relations WHERE movie_id = $1 AND relation_type IN ('SIMILAR', 'RECOMMENDATION')`,
      [tmdbId]
    )
    res.json({ items: result.rows })
  } catch (err) {
    res.status(500).json({ error: 'Ошибка' })
  }
})

app.get('/api/kinopoisk/:id/similars', authMiddleware, async (req, res) => {
  const tmdbId = parseInt(req.params.id)
  try {
    const result = await pool.query(
      `SELECT related_movie_id AS "filmId", relation_type AS "relationType",
         name_ru AS "nameRu", name_en AS "nameEn", name_original AS "nameOriginal",
         year, poster_url AS "posterUrl", poster_url_preview AS "posterUrlPreview"
       FROM movie_relations WHERE movie_id = $1 AND relation_type IN ('SIMILAR', 'RECOMMENDATION')`,
      [tmdbId]
    )
    res.json({ items: result.rows })
  } catch (err) {
    res.status(500).json({ error: 'Ошибка' })
  }
})

// ───────────────────────── SEASONS (TMDB) ─────────────────────────

app.get('/api/kinopoisk/:id/seasons', authMiddleware, async (req, res) => {
  const tmdbId = parseInt(req.params.id)
  try {
    const episodes = await getEpisodesFromDb(tmdbId)
    res.json({ episodes })
  } catch (err) {
    console.error('Ошибка загрузки сезонов:', err)
    res.status(500).json({ error: 'Ошибка загрузки сезонов' })
  }
})

app.get('/api/kinopoisk/:id/watched-episodes', authMiddleware, async (req, res) => {
  const tmdbId = parseInt(req.params.id)
  try {
    const result = await pool.query(
      'SELECT season_number, episode_number FROM user_episodes WHERE user_id = $1 AND movie_id = $2',
      [req.user.id, tmdbId]
    )
    res.json({ episodes: result.rows })
  } catch (err) {
    res.status(500).json({ error: 'Ошибка' })
  }
})

// ───────────────────────── EPISODES TOGGLE ─────────────────────────

async function recalcStatus(tmdbId, userId) {
  const episodes = await getEpisodesFromDb(tmdbId)
  const aired = episodes.filter(e =>
    e.release_date ? new Date(e.release_date) <= new Date() : false
  )
  const watched = await pool.query(
    'SELECT season_number, episode_number FROM user_episodes WHERE user_id = $1 AND movie_id = $2',
    [userId, tmdbId]
  )

  let newStatus = 'watching'
  if (aired.length > 0 && watched.rows.length >= aired.length) {
    newStatus = 'watched'
  } else if (watched.rows.length === 0) {
    await pool.query('DELETE FROM user_movies WHERE user_id = $1 AND movie_id = $2', [userId, tmdbId])
    return 'not_watched'
  }

  await pool.query(
    `INSERT INTO user_movies (user_id, movie_id, status) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, movie_id) DO UPDATE SET status = EXCLUDED.status`,
    [userId, tmdbId, newStatus]
  )
  return newStatus
}

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

    const newStatus = await recalcStatus(movieId, userId)
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
    await client.query('COMMIT')
    const newStatus = await recalcStatus(movieId, userId)
    res.json({ success: true, newStatus })
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Ошибка' })
  } finally {
    client.release()
  }
})

// ───────────────────────── MOVIES STATUS ─────────────────────────

app.post('/api/movies/bulk-statuses', authMiddleware, async (req, res) => {
  const { movieIds } = req.body
  if (!movieIds || !movieIds.length) return res.json({ statuses: {} })
  try {
    const result = await pool.query(
      'SELECT movie_id, status FROM user_movies WHERE user_id = $1 AND movie_id = ANY($2)',
      [req.user.id, movieIds]
    )
    const statuses = {}
    result.rows.forEach(r => { statuses[r.movie_id] = r.status })
    res.json({ statuses })
  } catch (err) {
    res.status(500).json({ error: 'Ошибка' })
  }
})

app.get('/api/movies/:movieId', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT status FROM user_movies WHERE user_id = $1 AND movie_id = $2',
      [req.user.id, parseInt(req.params.movieId)]
    )
    if (result.rows.length === 0) return res.json({ status: 'not_watched' })
    res.json({ status: result.rows[0].status })
  } catch (err) {
    res.status(500).json({ error: 'Ошибка' })
  }
})

app.post('/api/movies/:movieId', authMiddleware, async (req, res) => {
  const tmdbId = parseInt(req.params.movieId)
  const { status } = req.body
  const userId = req.user.id

  if (status === 'not_watched') {
    try {
      const watchedResult = await pool.query(
        'SELECT COUNT(*) FROM user_episodes WHERE user_id = $1 AND movie_id = $2',
        [userId, tmdbId]
      )
      if (parseInt(watchedResult.rows[0].count) > 0) {
        return res.status(400).json({ error: 'Нельзя сбросить, пока отмечены серии' })
      }
      await pool.query('DELETE FROM user_movies WHERE user_id = $1 AND movie_id = $2', [userId, tmdbId])
      return res.json({ status: 'not_watched' })
    } catch (err) {
      return res.status(500).json({ error: 'Ошибка' })
    }
  }

  const allowed = ['want_to_watch', 'watched', 'watching']
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Неверный статус' })

  if (status === 'watched') {
    const movieType = await pool.query('SELECT type FROM movies WHERE tmdb_id = $1', [tmdbId])
    if (movieType.rows[0]?.type === 'TV_SERIES' || movieType.rows[0]?.type === 'MINI_SERIES') {
      return res.status(400).json({ error: 'Сериалы нельзя отметить напрямую' })
    }
  }

  try {
    // Убедимся, что фильм есть в БД
    const exists = await pool.query('SELECT 1 FROM movies WHERE tmdb_id = $1', [tmdbId])
    if (exists.rows.length === 0) {
      await upsertTmdbMovie(tmdbId)
    }

    const result = await pool.query(
      `INSERT INTO user_movies (user_id, movie_id, status) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, movie_id) DO UPDATE SET status = EXCLUDED.status RETURNING *`,
      [userId, tmdbId, status]
    )
    res.json(result.rows[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка сохранения' })
  }
})

// ───────────────────────── FRIENDS ─────────────────────────

app.get('/api/users/search', authMiddleware, async (req, res) => {
  const { name } = req.query
  if (!name) return res.status(400).json({ error: 'Введите ник' })
  try {
    const result = await pool.query(
      'SELECT id, name FROM users WHERE name = $1 AND id != $2',
      [name, req.user.id]
    )
    if (result.rows.length === 0) return res.status(404).json({ error: 'Не найден' })
    res.json(result.rows[0])
  } catch (err) { res.status(500).json({ error: 'Ошибка' }) }
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
  } catch (err) { res.status(500).json({ error: 'Ошибка' }) }
})

app.post('/api/friends', authMiddleware, async (req, res) => {
  const { friendId } = req.body
  const userId = req.user.id
  if (userId === friendId) return res.status(400).json({ error: 'Нельзя себя' })

  try {
    const existing = await pool.query(
      `SELECT * FROM friendships WHERE (user_id_1 = $1 AND user_id_2 = $2) OR (user_id_1 = $2 AND user_id_2 = $1)`,
      [userId, friendId]
    )
    if (existing.rows.length > 0) return res.status(400).json({ error: 'Уже существует' })

    const result = await pool.query(
      `INSERT INTO friendships (user_id_1, user_id_2, status) VALUES ($1, $2, 'pending') RETURNING *`,
      [userId, friendId]
    )
    const sender = await pool.query('SELECT name FROM users WHERE id = $1', [userId])
    await createNotification(friendId, 'friend_request', `@${sender.rows[0]?.name} отправил заявку`, '/friends')
    io.emit('friends:updated', { userIds: [userId, friendId] })
    res.json(result.rows[0])
  } catch (err) { res.status(500).json({ error: 'Ошибка' }) }
})

app.patch('/api/friends/:id', authMiddleware, async (req, res) => {
  const { id } = req.params
  const userId = req.user.id
  try {
    const result = await pool.query(
      `UPDATE friendships SET status = 'accepted' WHERE id = $1 AND user_id_2 = $2 RETURNING *`, [id, userId]
    )
    if (result.rows.length === 0) return res.status(404).json({ error: 'Не найдена' })
    const f = result.rows[0]
    const accepter = await pool.query('SELECT name FROM users WHERE id = $1', [userId])
    await createNotification(f.user_id_1, 'friend_accepted', `@${accepter.rows[0]?.name} принял заявку`, '/friends')
    io.emit('friends:updated', { userIds: [f.user_id_1, f.user_id_2] })
    res.json(f)
  } catch (err) { res.status(500).json({ error: 'Ошибка' }) }
})

app.delete('/api/friends/:id', authMiddleware, async (req, res) => {
  const { id } = req.params
  const userId = req.user.id
  try {
    const result = await pool.query(
      `DELETE FROM friendships WHERE id = $1 AND (user_id_1 = $2 OR user_id_2 = $2) RETURNING *`, [id, userId]
    )
    if (result.rows.length === 0) return res.status(404).json({ error: 'Нет' })
    const f = result.rows[0]
    io.emit('friends:updated', { userIds: [f.user_id_1, f.user_id_2] })
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: 'Ошибка' }) }
})

// ───────────────────────── NOTIFICATIONS ─────────────────────────

app.get('/api/notifications', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, type, message, link, read, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    )
    const unreadCount = await pool.query(
      'SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND read = FALSE', [req.user.id]
    )
    res.json({ notifications: result.rows, unreadCount: parseInt(unreadCount.rows[0].count) })
  } catch (err) { res.status(500).json({ error: 'Ошибка' }) }
})

app.patch('/api/notifications/:id/read', authMiddleware, async (req, res) => {
  try {
    await pool.query('UPDATE notifications SET read = TRUE WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id])
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: 'Ошибка' }) }
})

app.patch('/api/notifications/read-all', authMiddleware, async (req, res) => {
  try {
    await pool.query('UPDATE notifications SET read = TRUE WHERE user_id = $1 AND read = FALSE', [req.user.id])
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: 'Ошибка' }) }
})

// ───────────────────────── MY SERIES ─────────────────────────

app.get('/api/users/me/watching', authMiddleware, async (req, res) => {
  const userId = req.user.id
  try {
    const moviesResult = await pool.query(
      `SELECT m.tmdb_id AS "kinopoiskId", m.tmdb_id AS "tmdbId", m.name_ru AS "nameRu",
        m.name_en AS "nameEn", m.poster_url_preview AS "posterUrlPreview", m.year
       FROM user_movies um JOIN movies m ON m.tmdb_id = um.movie_id
       WHERE um.user_id = $1 AND um.status = 'watching' ORDER BY um.id DESC`, [userId]
    )

    const series = []
    for (const movie of moviesResult.rows) {
      const episodes = await getEpisodesFromDb(movie.tmdbId)
      const aired = episodes.filter(e => e.release_date ? new Date(e.release_date) <= new Date() : false)

      const watchedEpisodes = await pool.query(
        `SELECT season_number, episode_number FROM user_episodes WHERE user_id = $1 AND movie_id = $2`,
        [userId, movie.tmdbId]
      )
      const watchedSet = new Set(watchedEpisodes.rows.map(e => `${e.season_number}-${e.episode_number}`))

      let nextEpisode = null
      for (const ep of aired) {
        if (!watchedSet.has(`${ep.season_number}-${ep.episode_number}`)) {
          nextEpisode = ep
          break
        }
      }

      series.push({
        ...movie,
        nextSeason: nextEpisode ? nextEpisode.season_number : null,
        nextEpisode: nextEpisode ? nextEpisode.episode_number : null,
        nextEpisodeName: nextEpisode ? nextEpisode.name_ru : null,
        nextEpisodeDate: nextEpisode ? nextEpisode.release_date : null,
        remaining: aired.length - watchedSet.size,
        totalAired: aired.length,
        watchedCount: watchedSet.size,
      })
    }
    res.json({ series })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка' })
  }
})

app.get('/api/users/me/watchlist-series', authMiddleware, async (req, res) => {
  const userId = req.user.id
  try {
    const result = await pool.query(
      `SELECT m.tmdb_id AS "kinopoiskId", m.tmdb_id AS "tmdbId", m.name_ru AS "nameRu",
        m.name_en AS "nameEn", m.name_original AS "nameOriginal", m.year, m.type,
        m.poster_url_preview AS "posterUrlPreview", m.rating_imdb AS "ratingKinopoisk",
        m.rating_imdb AS "ratingImdb", m.film_length AS "filmLength"
       FROM user_movies um JOIN movies m ON m.tmdb_id = um.movie_id
       WHERE um.user_id = $1 AND um.status = 'want_to_watch'
         AND m.type IN ('TV_SERIES', 'MINI_SERIES', 'TV_SHOW')
       ORDER BY um.id DESC`, [userId]
    )

    const series = []
    for (const row of result.rows) {
      const episodes = await getEpisodesFromDb(row.tmdbId)
      const aired = episodes.filter(e => e.release_date ? new Date(e.release_date) <= new Date() : false)

      const watchedResult = await pool.query(
        'SELECT COUNT(*) FROM user_episodes WHERE user_id = $1 AND movie_id = $2',
        [userId, row.tmdbId]
      )
      const watchedCount = parseInt(watchedResult.rows[0].count)
      const remaining = watchedCount > 0 ? Math.max(0, aired.length - watchedCount) : aired.length

      series.push({ ...row, episodesCount: aired.length, watchedCount, remaining })
    }
    res.json({ series })
  } catch (err) {
    res.status(500).json({ error: 'Ошибка' })
  }
})

app.get('/api/users/me/watchlist', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.tmdb_id AS "kinopoiskId", m.tmdb_id AS "tmdbId", m.name_ru AS "nameRu",
        m.name_en AS "nameEn", m.name_original AS "nameOriginal", m.year, m.type,
        m.poster_url_preview AS "posterUrlPreview", m.rating_imdb AS "ratingKinopoisk",
        m.rating_imdb AS "ratingImdb", m.film_length AS "filmLength", m.description
       FROM user_movies um JOIN movies m ON m.tmdb_id = um.movie_id
       WHERE um.user_id = $1 AND um.status = 'want_to_watch' AND m.type IN ('FILM', 'VIDEO')
       ORDER BY um.id DESC`, [req.user.id]
    )
    res.json({ movies: result.rows })
  } catch (err) {
    res.status(500).json({ error: 'Ошибка' })
  }
})

// ───────────────────────── PROFILE ─────────────────────────

app.get('/api/users/:id', authMiddleware, async (req, res) => {
  const { id } = req.params
  const currentUserId = req.user.id
  try {
    const userResult = await pool.query('SELECT id, name, email, created_at FROM users WHERE id = $1', [id])
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'Не найден' })
    const user = userResult.rows[0]

    const countsResult = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'watched') AS watched, COUNT(*) FILTER (WHERE status = 'want_to_watch') AS want_to_watch
       FROM user_movies WHERE user_id = $1`, [id]
    )
    const friendsCountResult = await pool.query(
      `SELECT COUNT(*) FROM friendships WHERE (user_id_1 = $1 OR user_id_2 = $1) AND status = 'accepted'`, [id]
    )

    let friendshipStatus = 'none', friendshipId = null, isFriend = false
    if (currentUserId !== parseInt(id)) {
      const friendshipResult = await pool.query(
        `SELECT id, user_id_1, user_id_2, status FROM friendships
         WHERE (user_id_1 = $1 AND user_id_2 = $2) OR (user_id_1 = $2 AND user_id_2 = $1) LIMIT 1`,
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
      stats: {
        watched: parseInt(countsResult.rows[0].watched),
        want_to_watch: parseInt(countsResult.rows[0].want_to_watch),
        not_watched: 0,
        friends: parseInt(friendsCountResult.rows[0].count),
      },
      isFriend, friendshipStatus, friendshipId, isOwn: currentUserId === parseInt(id),
    })
  } catch (err) {
    res.status(500).json({ error: 'Ошибка' })
  }
})

app.get('/api/users/:id/movies', authMiddleware, async (req, res) => {
  const { id } = req.params
  const currentUserId = req.user.id
  const { status } = req.query
  try {
    let query = `
      SELECT mv.tmdb_id AS "kinopoiskId", mv.tmdb_id AS "tmdbId", mv.name_ru AS "nameRu",
        mv.name_en AS "nameEn", mv.name_original AS "nameOriginal", mv.year,
        mv.poster_url_preview AS "posterUrlPreview",
        um_owner.status AS status, um_me.status AS my_status
      FROM user_movies um_owner
      LEFT JOIN movies mv ON mv.tmdb_id = um_owner.movie_id
      LEFT JOIN user_movies um_me ON um_me.movie_id = um_owner.movie_id AND um_me.user_id = $2
      WHERE um_owner.user_id = $1`
    const params = [id, currentUserId]
    if (status && status !== 'all') {
      query += ' AND um_owner.status = $3'
      params.push(status)
    }
    query += ' ORDER BY um_owner.id DESC'
    const result = await pool.query(query, params)
    res.json({ movies: result.rows })
  } catch (err) {
    res.status(500).json({ error: 'Ошибка' })
  }
})

app.get('/api/users/:id/common', authMiddleware, async (req, res) => {
  const { id } = req.params
  if (req.user.id === parseInt(id)) return res.status(400).json({ error: 'Себя нельзя' })
  try {
    const result = await pool.query(
      `SELECT mv.tmdb_id AS "kinopoiskId", mv.tmdb_id AS "tmdbId", mv.name_ru AS "nameRu",
         mv.name_en AS "nameEn", mv.name_original AS "nameOriginal", mv.year,
         mv.poster_url_preview AS "posterUrlPreview",
         u1.status AS my_status, u2.status AS their_status
       FROM user_movies u1
       JOIN user_movies u2 ON u2.movie_id = u1.movie_id AND u2.user_id = $2
       LEFT JOIN movies mv ON mv.tmdb_id = u1.movie_id
       WHERE u1.user_id = $1 AND u1.status = 'want_to_watch' AND u2.status = 'want_to_watch'
       ORDER BY mv.year DESC`,
      [req.user.id, id]
    )
    res.json({ movies: result.rows })
  } catch (err) {
    res.status(500).json({ error: 'Ошибка' })
  }
})

// ───────────────────────── MATCH ─────────────────────────

app.post('/api/match/rooms', authMiddleware, async (req, res) => {
  const { friendIds, criterion } = req.body
  if (!friendIds || friendIds.length === 0) return res.status(400).json({ error: 'Выберите друга' })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const roomResult = await client.query(
      `INSERT INTO match_rooms (organizer_id, criterion, status, current_round) VALUES ($1, $2, 'waiting', 1) RETURNING *`,
      [req.user.id, criterion]
    )
    const room = roomResult.rows[0]
    await client.query(
      `INSERT INTO match_participants (room_id, user_id, joined, responded) VALUES ($1, $2, TRUE, TRUE)`,
      [room.id, req.user.id]
    )
    for (const friendId of friendIds) {
      await client.query(
        `INSERT INTO match_participants (room_id, user_id, joined, responded) VALUES ($1, $2, FALSE, FALSE)`,
        [room.id, friendId]
      )
    }
    await client.query('COMMIT')

    const organizer = await pool.query('SELECT name FROM users WHERE id = $1', [req.user.id])
    for (const friendId of friendIds) {
      await createNotification(friendId, 'match_invite', `@${organizer.rows[0]?.name} приглашает подобрать фильм`, '/match')
      const friendSocket = onlineUsers.get(friendId)
      if (friendSocket) io.to(friendSocket).emit('match:invite', { roomId: room.id, organizerName: organizer.rows[0]?.name })
    }
    res.json(room)
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Ошибка' })
  } finally { client.release() }
})

app.get('/api/match/rooms', authMiddleware, async (req, res) => {
  try {
    const inv = await pool.query(
      `SELECT r.id AS room_id, r.criterion, r.status, r.created_at,
         u.name AS organizer_name, u.id AS organizer_id
       FROM match_rooms r JOIN match_participants p ON p.room_id = r.id JOIN users u ON u.id = r.organizer_id
       WHERE p.user_id = $1 AND p.responded = FALSE AND r.status = 'waiting'
       ORDER BY r.created_at DESC`, [req.user.id]
    )
    res.json({ invitations: inv.rows })
  } catch (err) { res.status(500).json({ error: 'Ошибка' }) }
})

app.get('/api/match/rooms/:id/movies', authMiddleware, async (req, res) => {
  try {
    const roomResult = await pool.query('SELECT current_round FROM match_rooms WHERE id = $1', [req.params.id])
    if (roomResult.rows.length === 0) return res.status(404).json({ error: 'Не найдена' })
    const round = roomResult.rows[0].current_round
    const result = await pool.query(
      `SELECT m.movie_id AS "kinopoiskId", m.movie_id AS "tmdbId",
         mv.name_ru AS "nameRu", mv.name_en AS "nameEn", mv.name_original AS "nameOriginal",
         mv.year, mv.poster_url_preview AS "posterUrlPreview"
       FROM match_movies m LEFT JOIN movies mv ON mv.tmdb_id = m.movie_id
       WHERE m.room_id = $1 AND m.round = $2`, [req.params.id, round]
    )
    res.json({ movies: result.rows, round })
  } catch (err) { res.status(500).json({ error: 'Ошибка' }) }
})

app.get('/api/match/rooms/:id', authMiddleware, async (req, res) => {
  try {
    const roomResult = await pool.query(
      `SELECT r.*, u.name AS organizer_name FROM match_rooms r JOIN users u ON u.id = r.organizer_id WHERE r.id = $1`,
      [req.params.id]
    )
    if (roomResult.rows.length === 0) return res.status(404).json({ error: 'Не найдена' })
    const part = await pool.query(
      `SELECT p.user_id AS id, u.name, p.joined, p.responded, p.declined,
         (p.user_id = r.organizer_id) AS is_organizer
       FROM match_participants p JOIN users u ON u.id = p.user_id JOIN match_rooms r ON r.id = p.room_id
       WHERE p.room_id = $1 ORDER BY is_organizer DESC`, [req.params.id]
    )
    res.json({ room: roomResult.rows[0], participants: part.rows })
  } catch (err) { res.status(500).json({ error: 'Ошибка' }) }
})

app.patch('/api/match/rooms/:id/respond', authMiddleware, async (req, res) => {
  const { accept } = req.body
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const upd = await client.query(
      `UPDATE match_participants SET responded = TRUE, declined = $1, joined = $2 WHERE room_id = $3 AND user_id = $4 RETURNING *`,
      [!accept, accept, req.params.id, req.user.id]
    )
    if (upd.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Нет' }) }
    if (!accept) {
      await client.query(`UPDATE match_rooms SET status = 'cancelled', cancelled_by = $1, cancelled_at = NOW() WHERE id = $2`, [req.user.id, req.params.id])
      const decliner = await client.query('SELECT name FROM users WHERE id = $1', [req.user.id])
      const room = await client.query('SELECT organizer_id FROM match_rooms WHERE id = $1', [req.params.id])
      if (room.rows[0]?.organizer_id !== req.user.id) {
        await createNotification(room.rows[0].organizer_id, 'match_cancelled', `@${decliner.rows[0]?.name} отклонил`, '/match')
      }
    }
    await client.query('COMMIT')
    io.to(`match_room_${req.params.id}`).emit('match:updated', { roomId: req.params.id })
    res.json({ success: true, accepted: accept })
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Ошибка' })
  } finally { client.release() }
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

    const participants = await pool.query('SELECT user_id FROM match_participants WHERE room_id = $1', [req.params.id])
    const participantIds = participants.rows.map(p => p.user_id)
    let moviesQuery, params = []

    if (room.current_round === 1) {
      params.push(participantIds)
      switch (room.criterion) {
        case 'common_want':
          moviesQuery = `SELECT movie_id FROM user_movies WHERE user_id = ANY($1) AND status = 'want_to_watch' GROUP BY movie_id HAVING COUNT(DISTINCT user_id) = $2`
          params.push(participantIds.length)
          break
        case 'common_all':
          moviesQuery = `SELECT movie_id FROM user_movies WHERE user_id = ANY($1) GROUP BY movie_id HAVING COUNT(DISTINCT user_id) = $2`
          params.push(participantIds.length)
          break
        case 'all_want':
          moviesQuery = `SELECT DISTINCT movie_id FROM user_movies WHERE user_id = ANY($1) AND status = 'want_to_watch'`
          break
        default:
          moviesQuery = `SELECT DISTINCT movie_id FROM user_movies WHERE user_id = ANY($1)`
      }
    } else {
      const prev = await pool.query(
        `SELECT movie_id FROM match_votes WHERE room_id = $1 AND round = $2 AND vote = 'yes' GROUP BY movie_id HAVING COUNT(DISTINCT user_id) = $3`,
        [req.params.id, room.current_round - 1, participantIds.length]
      )
      const approvedIds = prev.rows.map(r => r.movie_id)
      if (approvedIds.length === 0) return res.json({ movies: [], round: room.current_round })
      for (const movieId of approvedIds) {
        await pool.query(
          `INSERT INTO match_movies (room_id, movie_id, round) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [req.params.id, movieId, room.current_round]
        )
      }
      moviesQuery = `SELECT movie_id FROM match_movies WHERE room_id = $1 AND round = $2`
      params.push(req.params.id, room.current_round)
    }

    if (room.current_round === 1) {
      const movs = await pool.query(moviesQuery, params)
      if (movs.rows.length === 0) return res.json({ movies: [], round: 1 })
      for (const row of movs.rows) {
        await pool.query(
          `INSERT INTO match_movies (room_id, movie_id, round) VALUES ($1, $2, 1) ON CONFLICT DO NOTHING`,
          [req.params.id, row.movie_id]
        )
      }
    }

    await pool.query(`UPDATE match_rooms SET status = 'voting' WHERE id = $1`, [req.params.id])
    const moviesData = await pool.query(
      `SELECT m.movie_id AS "kinopoiskId", m.movie_id AS "tmdbId",
         mv.name_ru AS "nameRu", mv.name_en AS "nameEn", mv.name_original AS "nameOriginal",
         mv.year, mv.poster_url_preview AS "posterUrlPreview"
       FROM match_movies m LEFT JOIN movies mv ON mv.tmdb_id = m.movie_id
       WHERE m.room_id = $1 AND m.round = $2`, [req.params.id, room.current_round]
    )
    io.to(`match_room_${req.params.id}`).emit('match:round_started', { roomId: req.params.id, round: room.current_round })
    res.json({ movies: moviesData.rows, round: room.current_round })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка' })
  }
})

app.post('/api/match/rooms/:id/vote', authMiddleware, async (req, res) => {
  const { movieId, vote } = req.body
  if (!['yes', 'no'].includes(vote)) return res.status(400).json({ error: 'Неверный голос' })
  try {
    const room = await pool.query('SELECT current_round FROM match_rooms WHERE id = $1', [req.params.id])
    const round = room.rows[0]?.current_round || 1
    await pool.query(
      `INSERT INTO match_votes (room_id, movie_id, user_id, vote, round) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (room_id, movie_id, user_id, round) DO UPDATE SET vote = EXCLUDED.vote`,
      [req.params.id, movieId, req.user.id, vote, round]
    )
    io.to(`match_room_${req.params.id}`).emit('match:vote', { roomId: req.params.id, movieId, userId: req.user.id })
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: 'Ошибка' }) }
})

app.get('/api/match/rooms/:id/votes/:movieId', authMiddleware, async (req, res) => {
  try {
    const room = await pool.query('SELECT current_round FROM match_rooms WHERE id = $1', [req.params.id])
    const round = room.rows[0]?.current_round || 1
    const total = await pool.query('SELECT COUNT(*) FROM match_participants WHERE room_id = $1', [req.params.id])
    const votes = await pool.query(
      `SELECT COUNT(DISTINCT user_id) FROM match_votes WHERE room_id = $1 AND movie_id = $2 AND round = $3`,
      [req.params.id, req.params.movieId, round]
    )
    const totalP = parseInt(total.rows[0].count)
    const voted = parseInt(votes.rows[0].count)
    res.json({ allVoted: voted === totalP, votedCount: voted, totalParticipants: totalP })
  } catch (err) { res.status(500).json({ error: 'Ошибка' }) }
})

app.get('/api/match/rooms/:id/results', authMiddleware, async (req, res) => {
  try {
    const room = await pool.query('SELECT current_round FROM match_rooms WHERE id = $1', [req.params.id])
    const round = room.rows[0]?.current_round || 1
    const total = await pool.query('SELECT COUNT(*) FROM match_participants WHERE room_id = $1', [req.params.id])
    const totalP = parseInt(total.rows[0].count)

    const result = await pool.query(
      `SELECT m.movie_id AS "kinopoiskId", m.movie_id AS "tmdbId",
         mv.name_ru AS "nameRu", mv.name_en AS "nameEn", mv.name_original AS "nameOriginal",
         mv.year, mv.poster_url_preview AS "posterUrlPreview"
       FROM match_movies m
       LEFT JOIN match_votes v ON v.room_id = m.room_id AND v.movie_id = m.movie_id AND v.round = $2
       LEFT JOIN movies mv ON mv.tmdb_id = m.movie_id
       WHERE m.room_id = $1 AND m.round = $2
       GROUP BY m.movie_id, mv.name_ru, mv.name_en, mv.name_original, mv.year, mv.poster_url_preview
       HAVING COUNT(CASE WHEN v.vote = 'yes' THEN 1 END) = $3`,
      [req.params.id, round, totalP]
    )
    res.json({ approved: result.rows, round })
  } catch (err) { res.status(500).json({ error: 'Ошибка' }) }
})

app.post('/api/match/rooms/:id/next-round', authMiddleware, async (req, res) => {
  try {
    const roomResult = await pool.query('SELECT * FROM match_rooms WHERE id = $1', [req.params.id])
    const room = roomResult.rows[0]
    if (room.organizer_id !== req.user.id) return res.status(403).json({ error: 'Только организатор' })
    const newRound = room.current_round + 1
    const participants = await pool.query('SELECT user_id FROM match_participants WHERE room_id = $1', [req.params.id])

    const approved = await pool.query(
      `SELECT movie_id FROM match_votes WHERE room_id = $1 AND round = $2 AND vote = 'yes' GROUP BY movie_id HAVING COUNT(DISTINCT user_id) = $3`,
      [req.params.id, room.current_round, participants.rows.length]
    )
    const approvedIds = approved.rows.map(r => r.movie_id)
    if (approvedIds.length === 0) return res.status(400).json({ error: 'Нет одобренных' })

    for (const movieId of approvedIds) {
      await pool.query(
        `INSERT INTO match_movies (room_id, movie_id, round) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [req.params.id, movieId, newRound]
      )
    }
    await pool.query(`UPDATE match_rooms SET current_round = $1, status = 'voting' WHERE id = $2`, [newRound, req.params.id])

    const moviesData = await pool.query(
      `SELECT m.movie_id AS "kinopoiskId", m.movie_id AS "tmdbId",
         mv.name_ru AS "nameRu", mv.name_en AS "nameEn", mv.name_original AS "nameOriginal",
         mv.year, mv.poster_url_preview AS "posterUrlPreview"
       FROM match_movies m LEFT JOIN movies mv ON mv.tmdb_id = m.movie_id
       WHERE m.room_id = $1 AND m.round = $2`, [req.params.id, newRound]
    )
    io.to(`match_room_${req.params.id}`).emit('match:round_started', { roomId: req.params.id, round: newRound })
    res.json({ success: true, round: newRound, movies: moviesData.rows })
  } catch (err) { res.status(500).json({ error: 'Ошибка' }) }
})

app.patch('/api/match/rooms/:id/cancel', authMiddleware, async (req, res) => {
  try {
    const participant = await pool.query(
      'SELECT * FROM match_participants WHERE room_id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    )
    if (participant.rows.length === 0) return res.status(403).json({ error: 'Вы не участник' })

    await pool.query(
      `UPDATE match_rooms SET status = 'cancelled', cancelled_by = $1, cancelled_at = NOW() WHERE id = $2`,
      [req.user.id, req.params.id]
    )
    const canceller = await pool.query('SELECT name FROM users WHERE id = $1', [req.user.id])
    const others = await pool.query(
      'SELECT user_id FROM match_participants WHERE room_id = $1 AND user_id != $2',
      [req.params.id, req.user.id]
    )
    for (const p of others.rows) {
      await createNotification(p.user_id, 'match_cancelled', `@${canceller.rows[0]?.name} отменил`, '/match')
    }
    io.to(`match_room_${req.params.id}`).emit('match:cancelled', { roomId: req.params.id, cancelledByName: canceller.rows[0]?.name })
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: 'Ошибка' }) }
})

// ───────────────────────── START ─────────────────────────

httpServer.listen(process.env.PORT, () => {
  console.log(`Сервер запущен на порту ${process.env.PORT}`)
})