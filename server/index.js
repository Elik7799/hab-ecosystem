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

// ═════════════════════════ SOCKET.IO ═════════════════════════

const httpServer = http.createServer(app)
const io = new Server(httpServer, { cors: { origin: '*', credentials: true } })
const onlineUsers = new Map()

io.use((socket, next) => {
  const token = socket.handshake.auth.token
  if (!token) return next(new Error('Нет токена'))
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    socket.userId = decoded.id
    socket.userName = decoded.name
    next()
  } catch {
    next(new Error('Неверный токен'))
  }
})

io.on('connection', (socket) => {
  const userId = socket.userId
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
    onlineUsers.delete(userId)
    socket.broadcast.emit('user_offline', { userId })
    for (const roomId of socket.activeRooms) {
      try {
        const r = await pool.query('SELECT id, status FROM match_rooms WHERE id = $1', [roomId])
        if (r.rows.length === 0 || r.rows[0].status === 'cancelled') continue
        setTimeout(async () => {
          try {
            if (onlineUsers.has(userId)) return
            const p = await pool.query(
              'SELECT * FROM match_participants WHERE room_id = $1 AND user_id = $2',
              [roomId, userId]
            )
            if (p.rows.length === 0) return
            await pool.query(
              `UPDATE match_rooms SET status = 'cancelled', cancelled_by = $1, cancelled_at = NOW()
               WHERE id = $2 AND status != 'cancelled'`,
              [userId, roomId]
            )
            io.to(`match_room_${roomId}`).emit('match:cancelled', {
              roomId, cancelledByName: socket.userName, reason: 'disconnect',
            })
          } catch (err) { console.error('disconnect handler:', err.message) }
        }, 30000)
      } catch (err) { console.error('disconnect room lookup:', err.message) }
    }
  })
})

function emitNotification(userId, data) {
  const sid = onlineUsers.get(userId)
  if (sid) io.to(sid).emit('notification', data)
}

function authMiddleware(req, res, next) {
  const h = req.headers.authorization
  if (!h) return res.status(401).json({ error: 'Нет токена' })
  try {
    req.user = jwt.verify(h.split(' ')[1], process.env.JWT_SECRET)
    next()
  } catch {
    return res.status(401).json({ error: 'Неверный токен' })
  }
}

// ═════════════════════════ TMDB HELPERS ═════════════════════════

async function tmdbFetch(url, retries = 2) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TMDB_TOKEN}` } })
  if (res.status === 429 && retries > 0) {
    const ra = parseInt(res.headers.get('retry-after') || '10')
    await new Promise(r => setTimeout(r, ra * 1000))
    return tmdbFetch(url, retries - 1)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`TMDB HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  return res.json()
}

function pathTypeToDb(pt) {
  return pt === 'tv' ? 'TV_SERIES' : 'FILM'
}

// ═════════════════════════ UPSERT ═════════════════════════

async function upsertTmdbMovie(tmdbId, type) {
  if (!['FILM', 'TV_SERIES'].includes(type)) {
    throw new Error(`Invalid movie type: ${type}`)
  }
  const isTV = type === 'TV_SERIES'
  const endpoint = isTV ? 'tv' : 'movie'

  const data = await tmdbFetch(
    `${TMDB_BASE}/${endpoint}/${tmdbId}?language=ru-RU&append_to_response=external_ids`
  )

  const nameRu = data.title || data.name || '—'
  const nameOriginal = data.original_title || data.original_name || '—'
  const year = parseInt((data.release_date || data.first_air_date || '').slice(0, 4)) || 0
  const posterUrl = data.poster_path ? `${IMAGE_BASE}w500${data.poster_path}` : null
  const posterPreview = data.poster_path ? `${IMAGE_BASE}w200${data.poster_path}` : null
  const rating = data.vote_average || 0
  const description = data.overview || '—'
  const filmLength = isTV ? (data.episode_run_time?.[0] || 0) : (data.runtime || 0)
  const slogan = data.tagline || '—'
  const imdbId = data.external_ids?.imdb_id || null

  await pool.query(`
    INSERT INTO movies
      (tmdb_id, type, name_ru, name_original, year, poster_url, poster_url_preview,
       rating_imdb, description, film_length, slogan, imdb_id, last_checked_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
    ON CONFLICT (tmdb_id, type) DO UPDATE SET
      name_ru = EXCLUDED.name_ru,
      name_original = EXCLUDED.name_original,
      year = EXCLUDED.year,
      poster_url = EXCLUDED.poster_url,
      poster_url_preview = EXCLUDED.poster_url_preview,
      rating_imdb = EXCLUDED.rating_imdb,
      description = EXCLUDED.description,
      film_length = EXCLUDED.film_length,
      slogan = EXCLUDED.slogan,
      imdb_id = COALESCE(EXCLUDED.imdb_id, movies.imdb_id),
      last_checked_at = NOW()
  `, [tmdbId, type, nameRu, nameOriginal, year, posterUrl, posterPreview,
    rating, description, filmLength, slogan, imdbId])

  // Жанры
  await pool.query('DELETE FROM movie_genres WHERE movie_id = $1 AND movie_type = $2', [tmdbId, type])
  for (const g of data.genres || []) {
    await pool.query(
      `INSERT INTO movie_genres (movie_id, movie_type, genre) VALUES ($1, $2, $3)
       ON CONFLICT (movie_id, movie_type, genre) DO NOTHING`,
      [tmdbId, type, g.name]
    )
  }

  // Страны
  await pool.query('DELETE FROM movie_countries WHERE movie_id = $1 AND movie_type = $2', [tmdbId, type])
  for (const c of data.production_countries || []) {
    await pool.query(
      `INSERT INTO movie_countries (movie_id, movie_type, country) VALUES ($1, $2, $3)
       ON CONFLICT (movie_id, movie_type, country) DO NOTHING`,
      [tmdbId, type, c.name]
    )
  }

  if (isTV && data.seasons) {
    await syncTmdbSeasons(tmdbId, data.seasons)
  }

  await syncMovieRelations(tmdbId, type)

  return { tmdbId, type, isTV }
}

async function syncTmdbSeasons(tmdbId, seasons) {
  const valid = (seasons || []).filter(s => s.season_number > 0)
  for (const season of valid) {
    try {
      const sd = await tmdbFetch(
        `${TMDB_BASE}/tv/${tmdbId}/season/${season.season_number}?language=ru-RU`
      )
      for (const ep of sd.episodes || []) {
        if (ep.episode_number == null) continue
        await pool.query(`
          INSERT INTO tmdb_episodes
            (movie_id, movie_type, season_number, episode_number, name_ru, air_date, overview, tmdb_episode_id)
          VALUES ($1, 'TV_SERIES', $2, $3, $4, $5, $6, $7)
          ON CONFLICT (movie_id, movie_type, season_number, episode_number) DO UPDATE SET
            name_ru = EXCLUDED.name_ru,
            air_date = EXCLUDED.air_date,
            overview = EXCLUDED.overview`,
          [tmdbId, ep.season_number, ep.episode_number, ep.name || null,
            ep.air_date || null, ep.overview || null, ep.id])
      }
    } catch (err) {
      console.error(`Season ${season.season_number} for ${tmdbId}:`, err.message)
    }
  }
}

async function getEpisodesFromDb(tmdbId, type) {
  if (type !== 'TV_SERIES') return []

  const m = await pool.query(
    'SELECT last_checked_at FROM movies WHERE tmdb_id = $1 AND type = $2',
    [tmdbId, type]
  )
  if (m.rows.length === 0) return []

  const lastSync = m.rows[0].last_checked_at
  const needsRefresh = !lastSync || (Date.now() - new Date(lastSync).getTime()) > 7 * 24 * 60 * 60 * 1000

  const existing = await pool.query(
    `SELECT season_number, episode_number, name_ru, air_date as release_date
     FROM tmdb_episodes WHERE movie_id = $1 AND movie_type = $2
     ORDER BY season_number, episode_number`,
    [tmdbId, type]
  )

  if (existing.rows.length === 0 || needsRefresh) {
    try {
      await upsertTmdbMovie(tmdbId, type)
      const fresh = await pool.query(
        `SELECT season_number, episode_number, name_ru, air_date as release_date
         FROM tmdb_episodes WHERE movie_id = $1 AND movie_type = $2
         ORDER BY season_number, episode_number`,
        [tmdbId, type]
      )
      return fresh.rows
    } catch (err) {
      console.error(`Refresh ${tmdbId}:`, err.message)
      return existing.rows
    }
  }
  return existing.rows
}

// ═════════════════════════ RELATIONS ═════════════════════════

async function syncMovieRelations(tmdbId, type) {
  const isTV = type === 'TV_SERIES'
  const endpoint = isTV ? 'tv' : 'movie'
  const relatedType = isTV ? 'TV_SERIES' : 'FILM'

  try {
    const recData = await tmdbFetch(
      `${TMDB_BASE}/${endpoint}/${tmdbId}/recommendations?language=ru-RU&page=1`
    )
    const simData = await tmdbFetch(
      `${TMDB_BASE}/${endpoint}/${tmdbId}/similar?language=ru-RU&page=1`
    )

    let collectionParts = []
    if (!isTV) {
      const details = await tmdbFetch(`${TMDB_BASE}/movie/${tmdbId}?language=ru-RU`)
      if (details.belongs_to_collection) {
        const cd = await tmdbFetch(
          `${TMDB_BASE}/collection/${details.belongs_to_collection.id}?language=ru-RU`
        )
        collectionParts = cd.parts || []
      }
    }

    const all = [
      ...(recData.results || []).map(i => ({ ...i, relationType: 'RECOMMENDATION', rtype: relatedType })),
      ...(simData.results || []).map(i => ({ ...i, relationType: 'SIMILAR', rtype: relatedType })),
      ...collectionParts
        .filter(p => p.id !== tmdbId)
        .map(i => ({ ...i, relationType: 'SEQUEL', rtype: 'FILM' })),
    ]

    await pool.query(
      'DELETE FROM movie_relations WHERE movie_id = $1 AND movie_type = $2',
      [tmdbId, type]
    )

    for (const item of all) {
      if (!item.id || item.id === tmdbId) continue
      const nr = item.title || item.name || '—'
      const no = item.original_title || item.original_name || '—'
      const yr = parseInt((item.release_date || item.first_air_date || '').slice(0, 4)) || 0
      const pu = item.poster_path ? `${IMAGE_BASE}w500${item.poster_path}` : null
      const pp = item.poster_path ? `${IMAGE_BASE}w200${item.poster_path}` : null
      await pool.query(`
        INSERT INTO movie_relations
          (movie_id, movie_type, related_movie_id, related_movie_type, relation_type,
           name_ru, name_original, year, poster_url, poster_url_preview)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT DO NOTHING`,
        [tmdbId, type, item.id, item.rtype, item.relationType, nr, no, yr, pu, pp])
    }
  } catch (err) {
    console.error(`syncMovieRelations ${tmdbId}:`, err.message)
  }
}

// ═════════════════════════ NOTIFICATIONS ═════════════════════════

async function createNotification(userId, type, message, link = null) {
  try {
    await pool.query(
      'INSERT INTO notifications (user_id, type, message, link) VALUES ($1, $2, $3, $4)',
      [userId, type, message, link]
    )
    emitNotification(userId, { type, message, link })
  } catch (err) {
    console.error('createNotification:', err.message)
  }
}

// ═════════════════════════ AUTH ═════════════════════════

app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body
  try {
    const hash = await bcrypt.hash(password, 10)
    const r = await pool.query(
      'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email',
      [name, email, hash]
    )
    res.json(r.rows[0])
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Email или ник уже заняты' })
    res.status(500).json({ error: 'Ошибка регистрации' })
  }
})

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body
  try {
    const r = await pool.query('SELECT * FROM users WHERE email = $1', [email])
    if (r.rows.length === 0) return res.status(400).json({ error: 'Пользователь не найден' })
    const u = r.rows[0]
    if (!(await bcrypt.compare(password, u.password_hash))) {
      return res.status(400).json({ error: 'Неверный пароль' })
    }
    const token = jwt.sign(
      { id: u.id, name: u.name }, process.env.JWT_SECRET, { expiresIn: '30d' }
    )
    res.json({ token, user: { id: u.id, name: u.name, email: u.email } })
  } catch {
    res.status(500).json({ error: 'Ошибка входа' })
  }
})

// ═════════════════════════ IMPORT ═════════════════════════

app.post('/api/import/upload', authMiddleware, upload.single('file'), async (req, res) => {
  const file = req.file
  const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN
  const CHAT_ID = process.env.TELEGRAM_CHAT_ID
  if (!file) return res.status(400).json({ error: 'Файл не загружен' })
  const ext = file.originalname.split('.').pop().toLowerCase()
  if (ext !== 'xlsx') return res.status(400).json({ error: 'Только .xlsx' })
  const magic = file.buffer.slice(0, 4).toString('hex').toUpperCase()
  if (magic !== '504B0304') return res.status(400).json({ error: 'Файл поврежден' })
  if (!TELEGRAM_TOKEN || !CHAT_ID) return res.status(500).json({ error: 'Telegram не настроен' })
  try {
    const fd = new FormData()
    fd.append('chat_id', CHAT_ID)
    fd.append('caption', `Новый импорт от #${req.user.id}`)
    const blob = new Blob([file.buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    fd.append('document', blob, file.originalname)
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendDocument`, {
      method: 'POST', body: fd,
    })
    const data = await r.json()
    if (!data.ok) throw new Error(data.description || 'Telegram error')
    res.json({ success: true })
  } catch {
    res.status(500).json({ error: 'Не удалось отправить файл' })
  }
})

// ═════════════════════════ MAIN / SEARCH ═════════════════════════

app.get('/api/kinopoisk/main', authMiddleware, async (req, res) => {
  const page = parseInt(req.query.page) || 1
  const category = req.query.category || 'MARVEL'
  const typeFilter = req.query.type || 'ALL'
  const userId = req.user.id

  try {
    if (category === 'MARVEL') {
      const limit = parseInt(req.query.limit) || 20
      const offset = (page - 1) * limit
      let countQ = 'SELECT COUNT(*) FROM main_movies mm JOIN movies m ON m.id = mm.movie_id'
      let dataQ = `
        SELECT m.tmdb_id AS "kinopoiskId", m.tmdb_id AS "tmdbId", m.type,
          m.name_ru AS "nameRu", m.name_original AS "nameOriginal",
          m.year, m.poster_url AS "posterUrl", m.poster_url_preview AS "posterUrlPreview",
          m.rating_imdb AS "ratingKinopoisk", m.rating_imdb AS "ratingImdb",
          m.description, m.film_length AS "filmLength", m.slogan,
          COALESCE(um.status, 'not_watched') AS status
        FROM main_movies mm JOIN movies m ON m.id = mm.movie_id
        LEFT JOIN user_movies um
          ON um.movie_id = m.tmdb_id AND um.movie_type = m.type AND um.user_id = $3`
      const params = [limit, offset, userId]
      const countParams = []
      if (typeFilter !== 'ALL') {
        dataQ += ' WHERE m.type = $4'
        countQ += ' WHERE m.type = $1'
        params.push(typeFilter)
        countParams.push(typeFilter)
      }
      dataQ += ' ORDER BY mm.position ASC LIMIT $1 OFFSET $2'
      const cr = await pool.query(countQ, countParams)
      const total = parseInt(cr.rows[0].count)
      const result = await pool.query(dataQ, params)
      return res.json({
        items: result.rows, page, limit, total,
        totalPages: Math.ceil(total / limit),
        hasMore: offset + result.rows.length < total,
      })
    }

    let endpoint
    switch (category) {
      case 'TOP_POPULAR_ALL': endpoint = '/trending/all/week'; break
      case 'TOP_POPULAR_MOVIES': endpoint = '/movie/popular'; break
      case 'POPULAR_SERIES': endpoint = '/tv/popular'; break
      case 'TOP_250_TV_SHOWS': endpoint = '/tv/top_rated'; break
      case 'TOP_250_MOVIES': endpoint = '/movie/top_rated'; break
      default: endpoint = '/movie/popular'
    }

    const data = await tmdbFetch(`${TMDB_BASE}${endpoint}?page=${page}&language=ru-RU`)
    let items = data.results || []
    if (typeFilter !== 'ALL') {
      items = items.filter(i => {
        const t = i.media_type === 'tv' ? 'TV_SERIES' : 'FILM'
        return t === typeFilter
      })
    }

    const refs = items.map(i => ({
      id: i.id,
      type: i.media_type === 'tv' ? 'TV_SERIES' : 'FILM',
    }))
    const statusMap = {}
    if (refs.length > 0) {
      const ids = refs.map(r => r.id)
      const sr = await pool.query(
        `SELECT movie_id, movie_type, status FROM user_movies
         WHERE user_id = $1 AND movie_id = ANY($2)`,
        [userId, ids]
      )
      sr.rows.forEach(r => { statusMap[`${r.movie_id}:${r.movie_type}`] = r.status })
    }

    const responseItems = items.map(item => {
      const isTV = item.media_type === 'tv' || !!item.first_air_date
      const type = isTV ? 'TV_SERIES' : 'FILM'
      return {
        kinopoiskId: item.id,
        tmdbId: item.id,
        nameRu: item.title || item.name || '—',
        nameOriginal: item.original_title || item.original_name || '—',
        year: parseInt((item.release_date || item.first_air_date || '').slice(0, 4)) || 0,
        type,
        posterUrl: item.poster_path ? `${IMAGE_BASE}w500${item.poster_path}` : null,
        posterUrlPreview: item.poster_path ? `${IMAGE_BASE}w200${item.poster_path}` : null,
        ratingKinopoisk: item.vote_average || 0,
        ratingImdb: item.vote_average || 0,
        description: item.overview || '—',
        status: statusMap[`${item.id}:${type}`] || 'not_watched',
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

    const results = (data.results || [])
      .filter(i => i.media_type === 'movie' || i.media_type === 'tv')

    const refs = results.map(i => ({
      id: i.id,
      type: i.media_type === 'tv' ? 'TV_SERIES' : 'FILM',
    }))
    const statusMap = {}
    if (refs.length > 0) {
      const ids = refs.map(r => r.id)
      const sr = await pool.query(
        `SELECT movie_id, movie_type, status FROM user_movies
         WHERE user_id = $1 AND movie_id = ANY($2)`,
        [req.user.id, ids]
      )
      sr.rows.forEach(r => { statusMap[`${r.movie_id}:${r.movie_type}`] = r.status })
    }

    const films = results.map(item => {
      const isTV = item.media_type === 'tv'
      const type = isTV ? 'TV_SERIES' : 'FILM'
      return {
        kinopoiskId: item.id,
        tmdbId: item.id,
        nameRu: item.title || item.name || '—',
        nameOriginal: item.original_title || item.original_name || '—',
        year: parseInt((item.release_date || item.first_air_date || '').slice(0, 4)) || 0,
        type,
        posterUrlPreview: item.poster_path ? `${IMAGE_BASE}w200${item.poster_path}` : null,
        status: statusMap[`${item.id}:${type}`] || 'not_watched',
      }
    })
    res.json({ films })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка поиска' })
  }
})

// ═════════════════════════ DETAIL (по типу) ═════════════════════════

async function handleDetail(req, res, dbType) {
  const tmdbId = parseInt(req.params.id)
  if (!tmdbId) return res.status(400).json({ error: 'Неверный ID' })

  try {
    try {
      await upsertTmdbMovie(tmdbId, dbType)
    } catch (err) {
      console.error(`upsert ${dbType}/${tmdbId}:`, err.message)
    }

    const mr = await pool.query(
      'SELECT * FROM movies WHERE tmdb_id = $1 AND type = $2',
      [tmdbId, dbType]
    )
    if (mr.rows.length === 0) return res.status(404).json({ error: 'Не найдено' })
    const movie = mr.rows[0]

    const genres = await pool.query(
      'SELECT genre FROM movie_genres WHERE movie_id = $1 AND movie_type = $2',
      [tmdbId, dbType]
    )
    const countries = await pool.query(
      'SELECT country FROM movie_countries WHERE movie_id = $1 AND movie_type = $2',
      [tmdbId, dbType]
    )

    res.json({
      kinopoiskId: movie.tmdb_id,
      tmdbId: movie.tmdb_id,
      nameRu: movie.name_ru,
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
    res.status(500).json({ error: 'Ошибка загрузки' })
  }
}

app.get('/api/kinopoisk/movie/:id', authMiddleware, (req, res) => handleDetail(req, res, 'FILM'))
app.get('/api/kinopoisk/tv/:id', authMiddleware, (req, res) => handleDetail(req, res, 'TV_SERIES'))

// ═════════════════════════ RELATIONS / SIMILARS ═════════════════════════

async function ensureRelationsSynced(tmdbId, dbType) {
  const ex = await pool.query(
    'SELECT 1 FROM movie_relations WHERE movie_id = $1 AND movie_type = $2 LIMIT 1',
    [tmdbId, dbType]
  )
  if (ex.rows.length === 0) {
    await syncMovieRelations(tmdbId, dbType)
  }
}

async function handleRelations(req, res, dbType) {
  const tmdbId = parseInt(req.params.id)
  try {
    await ensureRelationsSynced(tmdbId, dbType)
    const r = await pool.query(`
      SELECT related_movie_id AS "kinopoiskId",
             related_movie_type AS "type",
             relation_type AS "relationType",
             name_ru AS "nameRu",
             name_original AS "nameOriginal",
             year, poster_url AS "posterUrl", poster_url_preview AS "posterUrlPreview"
      FROM movie_relations
      WHERE movie_id = $1 AND movie_type = $2
        AND relation_type IN ('SEQUEL', 'PREQUEL', 'REMAKE')
    `, [tmdbId, dbType])
    res.json({ items: r.rows })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка загрузки связанных' })
  }
}

async function handleSimilars(req, res, dbType) {
  const tmdbId = parseInt(req.params.id)
  try {
    await ensureRelationsSynced(tmdbId, dbType)
    const r = await pool.query(`
      SELECT related_movie_id AS "kinopoiskId",
             related_movie_type AS "type",
             relation_type AS "relationType",
             name_ru AS "nameRu",
             name_original AS "nameOriginal",
             year, poster_url AS "posterUrl", poster_url_preview AS "posterUrlPreview"
      FROM movie_relations
      WHERE movie_id = $1 AND movie_type = $2
        AND relation_type IN ('SIMILAR', 'RECOMMENDATION')
    `, [tmdbId, dbType])
    res.json({ items: r.rows })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка загрузки похожих' })
  }
}

app.get('/api/kinopoisk/movie/:id/relations', authMiddleware, (req, res) => handleRelations(req, res, 'FILM'))
app.get('/api/kinopoisk/tv/:id/relations', authMiddleware, (req, res) => handleRelations(req, res, 'TV_SERIES'))
app.get('/api/kinopoisk/movie/:id/similars', authMiddleware, (req, res) => handleSimilars(req, res, 'FILM'))
app.get('/api/kinopoisk/tv/:id/similars', authMiddleware, (req, res) => handleSimilars(req, res, 'TV_SERIES'))

// ═════════════════════════ SEASONS / WATCHED (только TV) ═════════════════════════

app.get('/api/kinopoisk/tv/:id/seasons', authMiddleware, async (req, res) => {
  const tmdbId = parseInt(req.params.id)
  try {
    const episodes = await getEpisodesFromDb(tmdbId, 'TV_SERIES')
    res.json({ episodes })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка загрузки сезонов' })
  }
})

app.get('/api/kinopoisk/tv/:id/watched-episodes', authMiddleware, async (req, res) => {
  const tmdbId = parseInt(req.params.id)
  try {
    const r = await pool.query(
      `SELECT season_number, episode_number FROM user_episodes
       WHERE user_id = $1 AND movie_id = $2 AND movie_type = 'TV_SERIES'`,
      [req.user.id, tmdbId]
    )
    res.json({ episodes: r.rows })
  } catch {
    res.status(500).json({ error: 'Ошибка' })
  }
})

// ═════════════════════════ EPISODES ═════════════════════════

async function recalcStatus(tmdbId, userId, force = false) {
  await getEpisodesFromDb(tmdbId, 'TV_SERIES')
  const res = await recalcUserSeriesStatus(userId, tmdbId, force)
  return res.newStatus
}

/**
 * Пересчитывает статус конкретного (user, series) без внешних запросов в TMDB.
 * Работает только если episodes уже в БД (tmdb_episodes).
 * Возвращает { changed, newStatus, oldStatus }.
 * - dropped / want_to_watch / not_watched — не трогает
 * - watching / watched — переоценивает (aired vs watched)
 */
async function recalcUserSeriesStatus(userId, tmdbId, force = false) {
  const cur = await pool.query(
    `SELECT status FROM user_movies
     WHERE user_id = $1 AND movie_id = $2 AND movie_type = 'TV_SERIES'`,
    [userId, tmdbId]
  )
  const oldStatus = cur.rows[0]?.status || 'not_watched'

  const episodes = await pool.query(
    `SELECT season_number, episode_number, air_date
     FROM tmdb_episodes
     WHERE movie_id = $1 AND movie_type = 'TV_SERIES'`,
    [tmdbId]
  )
  const now = new Date()
  const airedCount = episodes.rows.filter(e =>
    e.air_date && new Date(e.air_date) <= now
  ).length

  const watched = await pool.query(
    `SELECT COUNT(*)::int AS c FROM user_episodes
     WHERE user_id = $1 AND movie_id = $2 AND movie_type = 'TV_SERIES'`,
    [userId, tmdbId]
  )
  const watchedCount = watched.rows[0].c

  if (force && watchedCount > 0) {
    const newStatus = (airedCount > 0 && watchedCount >= airedCount)
      ? 'watched'
      : 'watching'
    if (oldStatus === newStatus && cur.rows.length > 0) {
      return { changed: false, newStatus, oldStatus }
    }
    await pool.query(
      `INSERT INTO user_movies (user_id, movie_id, movie_type, status, last_watched_at)
       VALUES ($1, $2, 'TV_SERIES', $3, NOW())
       ON CONFLICT (user_id, movie_id, movie_type) DO UPDATE SET
         status = EXCLUDED.status,
         last_watched_at = COALESCE(user_movies.last_watched_at, NOW())`,
      [userId, tmdbId, newStatus]
    )
    return { changed: true, newStatus, oldStatus }
  }

  if (oldStatus === 'dropped' || oldStatus === 'want_to_watch' || oldStatus === 'not_watched') {
    return { changed: false, newStatus: oldStatus, oldStatus }
  }
  if (cur.rows.length === 0) {
    return { changed: false, newStatus: 'not_watched', oldStatus: 'not_watched' }
  }

  let newStatus = oldStatus
  if (airedCount > 0 && watchedCount >= airedCount) {
    newStatus = 'watched'
  } else if (airedCount > 0 && watchedCount > 0 && watchedCount < airedCount) {
    newStatus = 'watching'
  } else if (watchedCount === 0 && airedCount > 0) {
    await pool.query(
      `DELETE FROM user_movies
       WHERE user_id = $1 AND movie_id = $2 AND movie_type = 'TV_SERIES'`,
      [userId, tmdbId]
    )
    return { changed: true, newStatus: 'not_watched', oldStatus }
  }

  if (newStatus !== oldStatus) {
    await pool.query(
      `UPDATE user_movies SET status = $1
       WHERE user_id = $2 AND movie_id = $3 AND movie_type = 'TV_SERIES'`,
      [newStatus, userId, tmdbId]
    )
    return { changed: true, newStatus, oldStatus }
  }
  return { changed: false, newStatus: oldStatus, oldStatus }
}

/**
 * Пересчитывает статусы ВСЕХ пользователей, у которых сериал в watching/watched.
 * Используется в таргетированном батче после глобального обновления.
 */
async function recalcStatusesForSeries(tmdbId) {
  try {
    const users = await pool.query(
      `SELECT user_id FROM user_movies
       WHERE movie_id = $1 AND movie_type = 'TV_SERIES'
         AND status IN ('watching', 'watched')`,
      [tmdbId]
    )
    if (users.rows.length === 0) return { checked: 0, changed: 0 }

    let changed = 0
    for (const row of users.rows) {
      const res = await recalcUserSeriesStatus(row.user_id, tmdbId)
      if (res.changed) changed++
    }
    return { checked: users.rows.length, changed }
  } catch (err) {
    console.error(`recalcStatusesForSeries ${tmdbId}:`, err.message)
    return { checked: 0, changed: 0 }
  }
}


app.post('/api/episodes/toggle', authMiddleware, async (req, res) => {
  const { movieId, seasonNumber, episodeNumber, watched } = req.body
  const userId = req.user.id
  try {
    if (watched) {
      await pool.query(`
        INSERT INTO user_episodes (user_id, movie_id, movie_type, season_number, episode_number)
        VALUES ($1, $2, 'TV_SERIES', $3, $4)
        ON CONFLICT (user_id, movie_id, movie_type, season_number, episode_number) DO NOTHING
      `, [userId, movieId, seasonNumber, episodeNumber])
    } else {
      await pool.query(`
        DELETE FROM user_episodes
        WHERE user_id = $1 AND movie_id = $2 AND movie_type = 'TV_SERIES'
          AND season_number = $3 AND episode_number = $4
      `, [userId, movieId, seasonNumber, episodeNumber])
    }
    const newStatus = await recalcStatus(movieId, userId, watched === true)
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
        await client.query(`
          INSERT INTO user_episodes (user_id, movie_id, movie_type, season_number, episode_number)
          VALUES ($1, $2, 'TV_SERIES', $3, $4)
          ON CONFLICT (user_id, movie_id, movie_type, season_number, episode_number) DO NOTHING
        `, [userId, movieId, seasonNumber, ep.episode_number])
      } else {
        await client.query(`
          DELETE FROM user_episodes
          WHERE user_id = $1 AND movie_id = $2 AND movie_type = 'TV_SERIES'
            AND season_number = $3 AND episode_number = $4
        `, [userId, movieId, seasonNumber, ep.episode_number])
      }
    }
    await client.query('COMMIT')
    const newStatus = await recalcStatus(movieId, userId, watched === true)
    res.json({ success: true, newStatus })
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Ошибка' })
  } finally {
    client.release()
  }
})

// ═════════════════════════ STATUS ═════════════════════════

app.post('/api/movies/bulk-statuses', authMiddleware, async (req, res) => {
  const { refs } = req.body
  if (!Array.isArray(refs) || refs.length === 0) return res.json({ statuses: {} })
  try {
    const ids = refs.map(r => r.tmdbId)
    const r = await pool.query(
      `SELECT movie_id, movie_type, status FROM user_movies
       WHERE user_id = $1 AND movie_id = ANY($2)`,
      [req.user.id, ids]
    )
    const statuses = {}
    r.rows.forEach(row => {
      statuses[`${row.movie_id}:${row.movie_type}`] = row.status
    })
    res.json({ statuses })
  } catch {
    res.status(500).json({ error: 'Ошибка' })
  }
})

async function getStatus(req, res, dbType) {
  const tmdbId = parseInt(req.params.id)
  const userId = req.user.id
  try {
    const r = await pool.query(
      'SELECT status FROM user_movies WHERE user_id = $1 AND movie_id = $2 AND movie_type = $3',
      [userId, tmdbId, dbType]
    )
    let currentStatus = r.rows[0]?.status || 'not_watched'

    if (dbType === 'TV_SERIES' &&
        (currentStatus === 'watching' || currentStatus === 'watched')) {
      const res2 = await recalcUserSeriesStatus(userId, tmdbId)
      if (res2.changed) currentStatus = res2.newStatus
    }

    res.json({ status: currentStatus })
  } catch (err) {
    console.error('getStatus:', err.message)
    res.status(500).json({ error: 'Ошибка' })
  }
}

async function setStatus(req, res, dbType) {
  const tmdbId = parseInt(req.params.id)
  const { status } = req.body
  const userId = req.user.id

  if (status === 'not_watched') {
    try {
      const watched = await pool.query(
        `SELECT COUNT(*) FROM user_episodes
         WHERE user_id = $1 AND movie_id = $2 AND movie_type = $3`,
        [userId, tmdbId, dbType]
      )
      if (parseInt(watched.rows[0].count) > 0) {
        return res.status(400).json({ error: 'Нельзя сбросить, пока отмечены серии' })
      }
      await pool.query(
        'DELETE FROM user_movies WHERE user_id = $1 AND movie_id = $2 AND movie_type = $3',
        [userId, tmdbId, dbType]
      )
      return res.json({ status: 'not_watched' })
    } catch (err) {
      console.error('setStatus(not_watched):', err.message)
      return res.status(500).json({ error: 'Ошибка' })
    }
  }

  const allowed = ['want_to_watch', 'watched', 'watching', 'dropped']
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Неверный статус' })

  if (dbType === 'FILM' && (status === 'watching' || status === 'dropped')) {
    return res.status(400).json({ error: 'Этот статус только для сериалов' })
  }
  if (dbType === 'TV_SERIES' && status === 'watched') {
    return res.status(400).json({ error: 'Сериалы нельзя отметить напрямую' })
  }

  try {
    const exists = await pool.query(
      'SELECT 1 FROM movies WHERE tmdb_id = $1 AND type = $2',
      [tmdbId, dbType]
    )
    if (exists.rows.length === 0) {
      await upsertTmdbMovie(tmdbId, dbType)
    }

    const r = await pool.query(`
      INSERT INTO user_movies (user_id, movie_id, movie_type, status, last_watched_at)
      VALUES (
        $1, $2, $3::varchar(20),
        $4::varchar(20),
        CASE WHEN $4::varchar(20) IN ('watching', 'dropped') THEN NOW() ELSE NULL END
      )
      ON CONFLICT (user_id, movie_id, movie_type) DO UPDATE SET
        status = EXCLUDED.status,
        last_watched_at = CASE
          WHEN EXCLUDED.status IN ('watching', 'dropped')
            THEN COALESCE(user_movies.last_watched_at, NOW())
          ELSE NULL
        END
      RETURNING *
    `, [userId, tmdbId, dbType, status])
    res.json(r.rows[0])
  } catch (err) {
    console.error('setStatus:', err.message)
    res.status(500).json({ error: 'Ошибка сохранения', detail: err.message })
  }
}

app.get('/api/movies/movie/:id', authMiddleware, (req, res) => getStatus(req, res, 'FILM'))
app.get('/api/movies/tv/:id', authMiddleware, (req, res) => getStatus(req, res, 'TV_SERIES'))
app.post('/api/movies/movie/:id', authMiddleware, (req, res) => setStatus(req, res, 'FILM'))
app.post('/api/movies/tv/:id', authMiddleware, (req, res) => setStatus(req, res, 'TV_SERIES'))

// ═════════════════════════ FRIENDS (без изменений) ═════════════════════════

app.get('/api/users/search', authMiddleware, async (req, res) => {
  const { name } = req.query
  if (!name) return res.status(400).json({ error: 'Введите ник' })
  try {
    const r = await pool.query(
      'SELECT id, name FROM users WHERE name = $1 AND id != $2',
      [name, req.user.id]
    )
    if (r.rows.length === 0) return res.status(404).json({ error: 'Не найден' })
    res.json(r.rows[0])
  } catch { res.status(500).json({ error: 'Ошибка' }) }
})

app.get('/api/friends', authMiddleware, async (req, res) => {
  const userId = req.user.id
  try {
    const friends = await pool.query(`
      SELECT u.id, u.name, f.id AS friendship_id, f.status
      FROM friendships f JOIN users u
        ON u.id = CASE WHEN f.user_id_1 = $1 THEN f.user_id_2 ELSE f.user_id_1 END
      WHERE (f.user_id_1 = $1 OR f.user_id_2 = $1) AND f.status = 'accepted'
    `, [userId])
    const requests = await pool.query(`
      SELECT u.id, u.name, f.id AS friendship_id, f.status
      FROM friendships f JOIN users u ON u.id = f.user_id_1
      WHERE f.user_id_2 = $1 AND f.status = 'pending'
    `, [userId])
    res.json({ friends: friends.rows, requests: requests.rows })
  } catch { res.status(500).json({ error: 'Ошибка' }) }
})

app.post('/api/friends', authMiddleware, async (req, res) => {
  const { friendId } = req.body
  const userId = req.user.id
  if (userId === friendId) return res.status(400).json({ error: 'Нельзя себя' })
  try {
    const ex = await pool.query(`
      SELECT * FROM friendships
      WHERE (user_id_1 = $1 AND user_id_2 = $2) OR (user_id_1 = $2 AND user_id_2 = $1)
    `, [userId, friendId])
    if (ex.rows.length > 0) return res.status(400).json({ error: 'Уже существует' })
    const r = await pool.query(
      `INSERT INTO friendships (user_id_1, user_id_2, status) VALUES ($1, $2, 'pending') RETURNING *`,
      [userId, friendId]
    )
    const sender = await pool.query('SELECT name FROM users WHERE id = $1', [userId])
    await createNotification(friendId, 'friend_request',
      `@${sender.rows[0]?.name} отправил заявку`, '/friends')
    io.emit('friends:updated', { userIds: [userId, friendId] })
    res.json(r.rows[0])
  } catch { res.status(500).json({ error: 'Ошибка' }) }
})

app.patch('/api/friends/:id', authMiddleware, async (req, res) => {
  const { id } = req.params
  const userId = req.user.id
  try {
    const r = await pool.query(
      `UPDATE friendships SET status = 'accepted' WHERE id = $1 AND user_id_2 = $2 RETURNING *`,
      [id, userId]
    )
    if (r.rows.length === 0) return res.status(404).json({ error: 'Не найдена' })
    const f = r.rows[0]
    const accepter = await pool.query('SELECT name FROM users WHERE id = $1', [userId])
    await createNotification(f.user_id_1, 'friend_accepted',
      `@${accepter.rows[0]?.name} принял заявку`, '/friends')
    io.emit('friends:updated', { userIds: [f.user_id_1, f.user_id_2] })
    res.json(f)
  } catch { res.status(500).json({ error: 'Ошибка' }) }
})

app.delete('/api/friends/:id', authMiddleware, async (req, res) => {
  const { id } = req.params
  const userId = req.user.id
  try {
    const r = await pool.query(
      `DELETE FROM friendships WHERE id = $1 AND (user_id_1 = $2 OR user_id_2 = $2) RETURNING *`,
      [id, userId]
    )
    if (r.rows.length === 0) return res.status(404).json({ error: 'Нет' })
    const f = r.rows[0]
    io.emit('friends:updated', { userIds: [f.user_id_1, f.user_id_2] })
    res.json({ success: true })
  } catch { res.status(500).json({ error: 'Ошибка' }) }
})

// ═════════════════════════ NOTIFICATIONS ═════════════════════════

app.get('/api/notifications', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, type, message, link, read, created_at FROM notifications
      WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50
    `, [req.user.id])
    const u = await pool.query(
      'SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND read = FALSE',
      [req.user.id]
    )
    res.json({ notifications: r.rows, unreadCount: parseInt(u.rows[0].count) })
  } catch { res.status(500).json({ error: 'Ошибка' }) }
})

app.patch('/api/notifications/:id/read', authMiddleware, async (req, res) => {
  try {
    await pool.query(
      'UPDATE notifications SET read = TRUE WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    )
    res.json({ success: true })
  } catch { res.status(500).json({ error: 'Ошибка' }) }
})

app.patch('/api/notifications/read-all', authMiddleware, async (req, res) => {
  try {
    await pool.query(
      'UPDATE notifications SET read = TRUE WHERE user_id = $1 AND read = FALSE',
      [req.user.id]
    )
    res.json({ success: true })
  } catch { res.status(500).json({ error: 'Ошибка' }) }
})

// ═════════════════════════ MY SERIES / WATCHLIST ═════════════════════════

app.get('/api/users/me/watching', authMiddleware, async (req, res) => {
  const userId = req.user.id
  try {
    const movies = await pool.query(`
      SELECT m.tmdb_id AS "kinopoiskId", m.tmdb_id AS "tmdbId", m.type,
        m.name_ru AS "nameRu", m.name_original AS "nameOriginal",
        m.poster_url_preview AS "posterUrlPreview", m.year,
        um.status,
        um.last_watched_at AS "lastWatchedAt"
      FROM user_movies um
      JOIN movies m ON m.tmdb_id = um.movie_id AND m.type = um.movie_type
      WHERE um.user_id = $1
        AND m.type = 'TV_SERIES'
        AND um.status IN ('watching', 'watched')
      ORDER BY um.id DESC
    `, [userId])

    const series = []
    for (const movie of movies.rows) {
      const episodes = await getEpisodesFromDb(movie.tmdbId, 'TV_SERIES')
      const aired = episodes.filter(e =>
        e.release_date ? new Date(e.release_date) <= new Date() : false
      )

      if (aired.length === 0) {
        continue
      }

      const watched = await pool.query(`
        SELECT season_number, episode_number FROM user_episodes
        WHERE user_id = $1 AND movie_id = $2 AND movie_type = 'TV_SERIES'
      `, [userId, movie.tmdbId])
      const watchedSet = new Set(watched.rows.map(e =>
        `${e.season_number}-${e.episode_number}`
      ))

      if (watchedSet.size >= aired.length) {
        if (movie.status === 'watching') {
          await pool.query(
            `UPDATE user_movies SET status = 'watched'
             WHERE user_id = $1 AND movie_id = $2 AND movie_type = 'TV_SERIES'`,
            [userId, movie.tmdbId]
          )
        }
        continue
      }

      if (movie.status === 'watched') {
        await pool.query(
          `UPDATE user_movies SET status = 'watching'
           WHERE user_id = $1 AND movie_id = $2 AND movie_type = 'TV_SERIES'`,
          [userId, movie.tmdbId]
        )
      }

      let next = null
      for (const ep of aired) {
        if (!watchedSet.has(`${ep.season_number}-${ep.episode_number}`)) {
          next = ep; break
        }
      }

      series.push({
        ...movie,
        status: 'watching',
        nextSeason: next?.season_number ?? null,
        nextEpisode: next?.episode_number ?? null,
        nextEpisodeName: next?.name_ru ?? null,
        nextEpisodeDate: next?.release_date ?? null,
        remaining: aired.length - watchedSet.size,
        totalAired: aired.length,
        watchedCount: watchedSet.size,
      })
    }
    res.json({ series })
  } catch (err) {
    console.error('/users/me/watching:', err.message)
    res.status(500).json({ error: 'Ошибка' })
  }
})

app.get('/api/users/me/watchlist-series', authMiddleware, async (req, res) => {
  const userId = req.user.id
  try {
    const r = await pool.query(`
      SELECT m.tmdb_id AS "kinopoiskId", m.tmdb_id AS "tmdbId", m.type,
        m.name_ru AS "nameRu", m.name_original AS "nameOriginal", m.year,
        m.poster_url_preview AS "posterUrlPreview",
        m.rating_imdb AS "ratingKinopoisk", m.rating_imdb AS "ratingImdb",
        m.film_length AS "filmLength"
      FROM user_movies um
      JOIN movies m ON m.tmdb_id = um.movie_id AND m.type = um.movie_type
      WHERE um.user_id = $1 AND um.status = 'want_to_watch' AND m.type = 'TV_SERIES'
      ORDER BY um.id DESC
    `, [userId])

    const series = []
    for (const row of r.rows) {
      const episodes = await getEpisodesFromDb(row.tmdbId, 'TV_SERIES')
      const aired = episodes.filter(e =>
        e.release_date ? new Date(e.release_date) <= new Date() : false
      )
      const wc = await pool.query(`
        SELECT COUNT(*) FROM user_episodes
        WHERE user_id = $1 AND movie_id = $2 AND movie_type = 'TV_SERIES'
      `, [userId, row.tmdbId])
      const watchedCount = parseInt(wc.rows[0].count)
      const remaining = watchedCount > 0 ? Math.max(0, aired.length - watchedCount) : aired.length
      series.push({ ...row, episodesCount: aired.length, watchedCount, remaining })
    }
    res.json({ series })
  } catch {
    res.status(500).json({ error: 'Ошибка' })
  }
})

app.get('/api/users/me/dropped', authMiddleware, async (req, res) => {
  const userId = req.user.id
  try {
    const r = await pool.query(`
      SELECT m.tmdb_id AS "kinopoiskId", m.tmdb_id AS "tmdbId", m.type,
        m.name_ru AS "nameRu", m.name_original AS "nameOriginal", m.year,
        m.poster_url_preview AS "posterUrlPreview",
        m.rating_imdb AS "ratingKinopoisk", m.rating_imdb AS "ratingImdb",
        m.film_length AS "filmLength",
        um.last_watched_at AS "lastWatchedAt"
      FROM user_movies um
      JOIN movies m ON m.tmdb_id = um.movie_id AND m.type = um.movie_type
      WHERE um.user_id = $1 AND um.status = 'dropped' AND m.type = 'TV_SERIES'
      ORDER BY um.last_watched_at DESC NULLS LAST, um.id DESC
    `, [userId])

    const series = []
    for (const row of r.rows) {
      const episodes = await getEpisodesFromDb(row.tmdbId, 'TV_SERIES')
      const aired = episodes.filter(e =>
        e.release_date ? new Date(e.release_date) <= new Date() : false
      )
      const wc = await pool.query(`
        SELECT COUNT(*) FROM user_episodes
        WHERE user_id = $1 AND movie_id = $2 AND movie_type = 'TV_SERIES'
      `, [userId, row.tmdbId])
      const watchedCount = parseInt(wc.rows[0].count)
      const remaining = watchedCount > 0
        ? Math.max(0, aired.length - watchedCount)
        : aired.length
      series.push({ ...row, episodesCount: aired.length, watchedCount, remaining })
    }
    res.json({ series })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка' })
  }
})

app.get('/api/users/me/watchlist', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT m.tmdb_id AS "kinopoiskId", m.tmdb_id AS "tmdbId", m.type,
        m.name_ru AS "nameRu", m.name_original AS "nameOriginal", m.year,
        m.poster_url_preview AS "posterUrlPreview",
        m.rating_imdb AS "ratingKinopoisk", m.rating_imdb AS "ratingImdb",
        m.film_length AS "filmLength", m.description
      FROM user_movies um
      JOIN movies m ON m.tmdb_id = um.movie_id AND m.type = um.movie_type
      WHERE um.user_id = $1 AND um.status = 'want_to_watch' AND m.type = 'FILM'
      ORDER BY um.id DESC
    `, [req.user.id])
    res.json({ movies: r.rows })
  } catch {
    res.status(500).json({ error: 'Ошибка' })
  }
})

// ═════════════════════════ PROFILE ═════════════════════════

app.get('/api/users/:id', authMiddleware, async (req, res) => {
  const { id } = req.params
  const current = req.user.id
  try {
    const u = await pool.query(
      'SELECT id, name, email, created_at FROM users WHERE id = $1', [id]
    )
    if (u.rows.length === 0) return res.status(404).json({ error: 'Не найден' })
    const user = u.rows[0]

    const cnt = await pool.query(`
     SELECT
       COUNT(*) FILTER (WHERE status = 'watched')        AS watched,
       COUNT(*) FILTER (WHERE status = 'want_to_watch')  AS want_to_watch,
       COUNT(*) FILTER (WHERE status = 'dropped')        AS dropped
     FROM user_movies WHERE user_id = $1
`, [id])
    const fr = await pool.query(
      `SELECT COUNT(*) FROM friendships
       WHERE (user_id_1 = $1 OR user_id_2 = $1) AND status = 'accepted'`, [id]
    )

    let friendshipStatus = 'none', friendshipId = null, isFriend = false
    if (current !== parseInt(id)) {
      const f = await pool.query(`
        SELECT id, user_id_1, user_id_2, status FROM friendships
        WHERE (user_id_1 = $1 AND user_id_2 = $2) OR (user_id_1 = $2 AND user_id_2 = $1)
        LIMIT 1
      `, [current, id])
      if (f.rows.length > 0) {
        const fr2 = f.rows[0]
        friendshipId = fr2.id
        if (fr2.status === 'accepted') { friendshipStatus = 'accepted'; isFriend = true }
        else if (fr2.status === 'pending') {
          friendshipStatus = fr2.user_id_1 === current ? 'pending_outgoing' : 'pending_incoming'
        }
      }
    }

    res.json({
      user: {
        id: user.id, name: user.name,
        email: current === parseInt(id) ? user.email : undefined,
        created_at: user.created_at,
      },
      stats: {
        watched: parseInt(cnt.rows[0].watched),
        want_to_watch: parseInt(cnt.rows[0].want_to_watch),
        dropped: parseInt(cnt.rows[0].dropped),
        not_watched: 0,
        friends: parseInt(fr.rows[0].count),
      },
      isFriend, friendshipStatus, friendshipId, isOwn: current === parseInt(id),
    })
  } catch { res.status(500).json({ error: 'Ошибка' }) }
})

app.get('/api/users/:id/movies', authMiddleware, async (req, res) => {
  const { id } = req.params
  const current = req.user.id
  const { status } = req.query
  try {
    let q = `
      SELECT mv.tmdb_id AS "kinopoiskId", mv.tmdb_id AS "tmdbId", mv.type,
        mv.name_ru AS "nameRu", mv.name_original AS "nameOriginal", mv.year,
        mv.poster_url_preview AS "posterUrlPreview",
        um_owner.status AS status, um_me.status AS my_status
      FROM user_movies um_owner
      LEFT JOIN movies mv
        ON mv.tmdb_id = um_owner.movie_id AND mv.type = um_owner.movie_type
      LEFT JOIN user_movies um_me
        ON um_me.movie_id = um_owner.movie_id
        AND um_me.movie_type = um_owner.movie_type
        AND um_me.user_id = $2
      WHERE um_owner.user_id = $1
    `
    const params = [id, current]
    if (status && status !== 'all') {
      q += ' AND um_owner.status = $3'
      params.push(status)
    }
    q += ' ORDER BY um_owner.id DESC'
    const r = await pool.query(q, params)
    res.json({ movies: r.rows })
  } catch { res.status(500).json({ error: 'Ошибка' }) }
})

app.get('/api/users/:id/common', authMiddleware, async (req, res) => {
  const { id } = req.params
  if (req.user.id === parseInt(id)) return res.status(400).json({ error: 'Себя нельзя' })
  try {
    const r = await pool.query(`
      SELECT mv.tmdb_id AS "kinopoiskId", mv.tmdb_id AS "tmdbId", mv.type,
        mv.name_ru AS "nameRu", mv.name_original AS "nameOriginal", mv.year,
        mv.poster_url_preview AS "posterUrlPreview",
        u1.status AS my_status, u2.status AS their_status
      FROM user_movies u1
      JOIN user_movies u2
        ON u2.movie_id = u1.movie_id
        AND u2.movie_type = u1.movie_type
        AND u2.user_id = $2
      LEFT JOIN movies mv
        ON mv.tmdb_id = u1.movie_id AND mv.type = u1.movie_type
      WHERE u1.user_id = $1 AND u1.status = 'want_to_watch' AND u2.status = 'want_to_watch'
      ORDER BY mv.year DESC
    `, [req.user.id, id])
    res.json({ movies: r.rows })
  } catch { res.status(500).json({ error: 'Ошибка' }) }
})

// ═════════════════════════ MATCH ═════════════════════════

app.post('/api/match/rooms', authMiddleware, async (req, res) => {
  const { friendIds, criterion } = req.body
  if (!friendIds || friendIds.length === 0) return res.status(400).json({ error: 'Выберите друга' })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const rr = await client.query(`
      INSERT INTO match_rooms (organizer_id, criterion, status, current_round)
      VALUES ($1, $2, 'waiting', 1) RETURNING *
    `, [req.user.id, criterion])
    const room = rr.rows[0]
    await client.query(`
      INSERT INTO match_participants (room_id, user_id, joined, responded)
      VALUES ($1, $2, TRUE, TRUE)
    `, [room.id, req.user.id])
    for (const fid of friendIds) {
      await client.query(`
        INSERT INTO match_participants (room_id, user_id, joined, responded)
        VALUES ($1, $2, FALSE, FALSE)
      `, [room.id, fid])
    }
    await client.query('COMMIT')

    const org = await pool.query('SELECT name FROM users WHERE id = $1', [req.user.id])
    for (const fid of friendIds) {
      await createNotification(fid, 'match_invite',
        `@${org.rows[0]?.name} приглашает подобрать фильм`, '/match')
      const fs = onlineUsers.get(fid)
      if (fs) io.to(fs).emit('match:invite', { roomId: room.id, organizerName: org.rows[0]?.name })
    }
    res.json(room)
  } catch {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Ошибка' })
  } finally { client.release() }
})

app.get('/api/match/rooms', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT r.id AS room_id, r.criterion, r.status, r.created_at,
        u.name AS organizer_name, u.id AS organizer_id
      FROM match_rooms r
      JOIN match_participants p ON p.room_id = r.id
      JOIN users u ON u.id = r.organizer_id
      WHERE p.user_id = $1 AND p.responded = FALSE AND r.status = 'waiting'
      ORDER BY r.created_at DESC
    `, [req.user.id])
    res.json({ invitations: r.rows })
  } catch { res.status(500).json({ error: 'Ошибка' }) }
})

app.get('/api/match/rooms/:id/movies', authMiddleware, async (req, res) => {
  try {
    const rr = await pool.query('SELECT current_round FROM match_rooms WHERE id = $1', [req.params.id])
    if (rr.rows.length === 0) return res.status(404).json({ error: 'Не найдена' })
    const round = rr.rows[0].current_round
    const r = await pool.query(`
      SELECT m.movie_id AS "kinopoiskId", m.movie_id AS "tmdbId", m.movie_type AS "type",
        mv.name_ru AS "nameRu", mv.name_original AS "nameOriginal",
        mv.year, mv.poster_url_preview AS "posterUrlPreview"
      FROM match_movies m
      LEFT JOIN movies mv
        ON mv.tmdb_id = m.movie_id AND mv.type = m.movie_type
      WHERE m.room_id = $1 AND m.round = $2
    `, [req.params.id, round])
    res.json({ movies: r.rows, round })
  } catch { res.status(500).json({ error: 'Ошибка' }) }
})

app.get('/api/match/rooms/:id', authMiddleware, async (req, res) => {
  try {
    const rr = await pool.query(`
      SELECT r.*, u.name AS organizer_name
      FROM match_rooms r JOIN users u ON u.id = r.organizer_id
      WHERE r.id = $1
    `, [req.params.id])
    if (rr.rows.length === 0) return res.status(404).json({ error: 'Не найдена' })
    const part = await pool.query(`
      SELECT p.user_id AS id, u.name, p.joined, p.responded, p.declined,
        (p.user_id = r.organizer_id) AS is_organizer
      FROM match_participants p
      JOIN users u ON u.id = p.user_id
      JOIN match_rooms r ON r.id = p.room_id
      WHERE p.room_id = $1
      ORDER BY is_organizer DESC
    `, [req.params.id])
    res.json({ room: rr.rows[0], participants: part.rows })
  } catch { res.status(500).json({ error: 'Ошибка' }) }
})

app.patch('/api/match/rooms/:id/respond', authMiddleware, async (req, res) => {
  const { accept } = req.body
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const upd = await client.query(`
      UPDATE match_participants
      SET responded = TRUE, declined = $1, joined = $2
      WHERE room_id = $3 AND user_id = $4 RETURNING *
    `, [!accept, accept, req.params.id, req.user.id])
    if (upd.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Нет' }) }
    if (!accept) {
      await client.query(`
        UPDATE match_rooms SET status = 'cancelled', cancelled_by = $1, cancelled_at = NOW()
        WHERE id = $2
      `, [req.user.id, req.params.id])
      const decliner = await client.query('SELECT name FROM users WHERE id = $1', [req.user.id])
      const room = await client.query('SELECT organizer_id FROM match_rooms WHERE id = $1', [req.params.id])
      if (room.rows[0]?.organizer_id !== req.user.id) {
        await createNotification(room.rows[0].organizer_id, 'match_cancelled',
          `@${decliner.rows[0]?.name} отклонил`, '/match')
      }
    }
    await client.query('COMMIT')
    io.to(`match_room_${req.params.id}`).emit('match:updated', { roomId: req.params.id })
    res.json({ success: true, accepted: accept })
  } catch {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Ошибка' })
  } finally { client.release() }
})

app.post('/api/match/rooms/:id/round', authMiddleware, async (req, res) => {
  try {
    const rr = await pool.query('SELECT * FROM match_rooms WHERE id = $1', [req.params.id])
    if (rr.rows.length === 0) return res.status(404).json({ error: 'Не найдена' })
    const room = rr.rows[0]
    if (room.organizer_id !== req.user.id) return res.status(403).json({ error: 'Только организатор' })
    if (room.status === 'cancelled') return res.status(400).json({ error: 'Закрыта' })

    if (room.current_round === 1) {
      const notResp = await pool.query(
        `SELECT COUNT(*) FROM match_participants WHERE room_id = $1 AND responded = FALSE`,
        [req.params.id]
      )
      if (parseInt(notResp.rows[0].count) > 0) return res.status(400).json({ error: 'Не все приняли' })
    }

    const parts = await pool.query(
      'SELECT user_id FROM match_participants WHERE room_id = $1', [req.params.id]
    )
    const pids = parts.rows.map(p => p.user_id)
    let mq, params = []

    if (room.current_round === 1) {
      params.push(pids)
      switch (room.criterion) {
        case 'common_want':
          mq = `SELECT movie_id, movie_type FROM user_movies
                WHERE user_id = ANY($1) AND status = 'want_to_watch'
                GROUP BY movie_id, movie_type
                HAVING COUNT(DISTINCT user_id) = $2`
          params.push(pids.length)
          break
        case 'common_all':
          mq = `SELECT movie_id, movie_type FROM user_movies
                WHERE user_id = ANY($1)
                GROUP BY movie_id, movie_type
                HAVING COUNT(DISTINCT user_id) = $2`
          params.push(pids.length)
          break
        case 'all_want':
          mq = `SELECT DISTINCT movie_id, movie_type FROM user_movies
                WHERE user_id = ANY($1) AND status = 'want_to_watch'`
          break
        default:
          mq = `SELECT DISTINCT movie_id, movie_type FROM user_movies WHERE user_id = ANY($1)`
      }
    } else {
      const prev = await pool.query(`
        SELECT movie_id, movie_type FROM match_votes
        WHERE room_id = $1 AND round = $2 AND vote = 'yes'
        GROUP BY movie_id, movie_type
        HAVING COUNT(DISTINCT user_id) = $3
      `, [req.params.id, room.current_round - 1, pids.length])
      if (prev.rows.length === 0) return res.json({ movies: [], round: room.current_round })
      for (const row of prev.rows) {
        await pool.query(`
          INSERT INTO match_movies (room_id, movie_id, movie_type, round)
          VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING
        `, [req.params.id, row.movie_id, row.movie_type, room.current_round])
      }
      mq = `SELECT movie_id, movie_type FROM match_movies WHERE room_id = $1 AND round = $2`
      params.push(req.params.id, room.current_round)
    }

    if (room.current_round === 1) {
      const movs = await pool.query(mq, params)
      if (movs.rows.length === 0) return res.json({ movies: [], round: 1 })
      for (const row of movs.rows) {
        await pool.query(`
          INSERT INTO match_movies (room_id, movie_id, movie_type, round)
          VALUES ($1, $2, $3, 1) ON CONFLICT DO NOTHING
        `, [req.params.id, row.movie_id, row.movie_type])
      }
    }

    await pool.query(`UPDATE match_rooms SET status = 'voting' WHERE id = $1`, [req.params.id])
    const md = await pool.query(`
      SELECT m.movie_id AS "kinopoiskId", m.movie_id AS "tmdbId", m.movie_type AS "type",
        mv.name_ru AS "nameRu", mv.name_original AS "nameOriginal",
        mv.year, mv.poster_url_preview AS "posterUrlPreview"
      FROM match_movies m
      LEFT JOIN movies mv ON mv.tmdb_id = m.movie_id AND mv.type = m.movie_type
      WHERE m.room_id = $1 AND m.round = $2
    `, [req.params.id, room.current_round])
    io.to(`match_room_${req.params.id}`).emit('match:round_started', { roomId: req.params.id, round: room.current_round })
    res.json({ movies: md.rows, round: room.current_round })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Ошибка' })
  }
})

app.post('/api/match/rooms/:id/vote', authMiddleware, async (req, res) => {
  const { movieId, movieType, vote } = req.body
  if (!['yes', 'no'].includes(vote)) return res.status(400).json({ error: 'Неверный голос' })
  try {
    const rr = await pool.query(
      'SELECT current_round FROM match_rooms WHERE id = $1', [req.params.id]
    )
    const round = rr.rows[0]?.current_round || 1
    await pool.query(`
      INSERT INTO match_votes (room_id, movie_id, movie_type, user_id, vote, round)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (room_id, movie_id, user_id, round) DO UPDATE SET vote = EXCLUDED.vote
    `, [req.params.id, movieId, movieType, req.user.id, vote, round])
    io.to(`match_room_${req.params.id}`).emit('match:vote', {
      roomId: req.params.id, movieId, userId: req.user.id,
    })
    res.json({ success: true })
  } catch { res.status(500).json({ error: 'Ошибка' }) }
})

app.get('/api/match/rooms/:id/votes/:movieId', authMiddleware, async (req, res) => {
  try {
    const rr = await pool.query(
      'SELECT current_round FROM match_rooms WHERE id = $1', [req.params.id]
    )
    const round = rr.rows[0]?.current_round || 1
    const tot = await pool.query(
      'SELECT COUNT(*) FROM match_participants WHERE room_id = $1', [req.params.id]
    )
    const v = await pool.query(`
      SELECT COUNT(DISTINCT user_id) FROM match_votes
      WHERE room_id = $1 AND movie_id = $2 AND round = $3
    `, [req.params.id, req.params.movieId, round])
    const totalP = parseInt(tot.rows[0].count)
    const voted = parseInt(v.rows[0].count)
    res.json({ allVoted: voted === totalP, votedCount: voted, totalParticipants: totalP })
  } catch { res.status(500).json({ error: 'Ошибка' }) }
})

app.get('/api/match/rooms/:id/results', authMiddleware, async (req, res) => {
  try {
    const rr = await pool.query(
      'SELECT current_round FROM match_rooms WHERE id = $1', [req.params.id]
    )
    const round = rr.rows[0]?.current_round || 1
    const tot = await pool.query(
      'SELECT COUNT(*) FROM match_participants WHERE room_id = $1', [req.params.id]
    )
    const totalP = parseInt(tot.rows[0].count)

    const r = await pool.query(`
      SELECT m.movie_id AS "kinopoiskId", m.movie_id AS "tmdbId", m.movie_type AS "type",
        mv.name_ru AS "nameRu", mv.name_original AS "nameOriginal",
        mv.year, mv.poster_url_preview AS "posterUrlPreview"
      FROM match_movies m
      LEFT JOIN match_votes v
        ON v.room_id = m.room_id AND v.movie_id = m.movie_id
        AND v.movie_type = m.movie_type AND v.round = $2
      LEFT JOIN movies mv ON mv.tmdb_id = m.movie_id AND mv.type = m.movie_type
      WHERE m.room_id = $1 AND m.round = $2
      GROUP BY m.movie_id, m.movie_type, mv.name_ru, mv.name_original, mv.year, mv.poster_url_preview
      HAVING COUNT(CASE WHEN v.vote = 'yes' THEN 1 END) = $3
    `, [req.params.id, round, totalP])
    res.json({ approved: r.rows, round })
  } catch { res.status(500).json({ error: 'Ошибка' }) }
})

app.post('/api/match/rooms/:id/next-round', authMiddleware, async (req, res) => {
  try {
    const rr = await pool.query('SELECT * FROM match_rooms WHERE id = $1', [req.params.id])
    const room = rr.rows[0]
    if (room.organizer_id !== req.user.id) return res.status(403).json({ error: 'Только организатор' })
    const newRound = room.current_round + 1
    const parts = await pool.query(
      'SELECT user_id FROM match_participants WHERE room_id = $1', [req.params.id]
    )

    const approved = await pool.query(`
      SELECT movie_id, movie_type FROM match_votes
      WHERE room_id = $1 AND round = $2 AND vote = 'yes'
      GROUP BY movie_id, movie_type
      HAVING COUNT(DISTINCT user_id) = $3
    `, [req.params.id, room.current_round, parts.rows.length])
    if (approved.rows.length === 0) return res.status(400).json({ error: 'Нет одобренных' })

    for (const row of approved.rows) {
      await pool.query(`
        INSERT INTO match_movies (room_id, movie_id, movie_type, round)
        VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING
      `, [req.params.id, row.movie_id, row.movie_type, newRound])
    }
    await pool.query(
      `UPDATE match_rooms SET current_round = $1, status = 'voting' WHERE id = $2`,
      [newRound, req.params.id]
    )

    const md = await pool.query(`
      SELECT m.movie_id AS "kinopoiskId", m.movie_id AS "tmdbId", m.movie_type AS "type",
        mv.name_ru AS "nameRu", mv.name_original AS "nameOriginal",
        mv.year, mv.poster_url_preview AS "posterUrlPreview"
      FROM match_movies m
      LEFT JOIN movies mv ON mv.tmdb_id = m.movie_id AND mv.type = m.movie_type
      WHERE m.room_id = $1 AND m.round = $2
    `, [req.params.id, newRound])
    io.to(`match_room_${req.params.id}`).emit('match:round_started', { roomId: req.params.id, round: newRound })
    res.json({ success: true, round: newRound, movies: md.rows })
  } catch { res.status(500).json({ error: 'Ошибка' }) }
})

app.patch('/api/match/rooms/:id/cancel', authMiddleware, async (req, res) => {
  try {
    const p = await pool.query(
      'SELECT * FROM match_participants WHERE room_id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    )
    if (p.rows.length === 0) return res.status(403).json({ error: 'Вы не участник' })
    await pool.query(
      `UPDATE match_rooms SET status = 'cancelled', cancelled_by = $1, cancelled_at = NOW() WHERE id = $2`,
      [req.user.id, req.params.id]
    )
    const canceller = await pool.query('SELECT name FROM users WHERE id = $1', [req.user.id])
    const others = await pool.query(
      'SELECT user_id FROM match_participants WHERE room_id = $1 AND user_id != $2',
      [req.params.id, req.user.id]
    )
    for (const o of others.rows) {
      await createNotification(o.user_id, 'match_cancelled',
        `@${canceller.rows[0]?.name} отменил`, '/match')
    }
    io.to(`match_room_${req.params.id}`).emit('match:cancelled', {
      roomId: req.params.id, cancelledByName: canceller.rows[0]?.name,
    })
    res.json({ success: true })
  } catch { res.status(500).json({ error: 'Ошибка' }) }
})

// ═════════════════════════ HYDRATE USER_MOVIES ═════════════════════════

/**
 * Гарантирует, что все (movie_id, movie_type) из user_movies
 * существуют в movies. Для отсутствующих — подтягивает из TMDB.
 * Логирует каждый кейс.
 */
async function ensureUserMoviesExist() {
  console.log('🔎 Проверка user_movies на сирот в movies...')

  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT um.movie_id, um.movie_type
      FROM user_movies um
      LEFT JOIN movies m
        ON m.tmdb_id = um.movie_id AND m.type = um.movie_type
      WHERE m.id IS NULL
        AND um.movie_id IS NOT NULL
        AND um.movie_type IN ('FILM', 'TV_SERIES')
      ORDER BY um.movie_type, um.movie_id
    `)

    if (rows.length === 0) {
      console.log('✅ Сирот нет — все user_movies есть в movies')
      return
    }

    console.log(`⚠️  Найдено ${rows.length} сирот в user_movies. Восстанавливаю...`)

    let ok = 0
    let fail = 0

    for (let i = 0; i < rows.length; i++) {
      const { movie_id, movie_type } = rows[i]
      const prefix = `[${i + 1}/${rows.length}] ${movie_type}/${movie_id}`

      try {
        await upsertTmdbMovie(movie_id, movie_type)

        const check = await pool.query(
          'SELECT 1 FROM movies WHERE tmdb_id = $1 AND type = $2',
          [movie_id, movie_type]
        )
        if (check.rows.length === 0) {
          console.log(`  ⚠️  ${prefix} — upsert прошёл, но строки в movies нет (TMDB не вернул?)`)
          fail++
        } else {
          console.log(`  ✅ ${prefix} — добавлен/обновлён`)
          ok++
        }
      } catch (err) {
        console.log(`  ❌ ${prefix} — ошибка: ${err.message}`)
        fail++
      }

      await new Promise(r => setTimeout(r, 250))
    }

    console.log(`🏁 Восстановление user_movies: ✅ ${ok} / ❌ ${fail}`)
  } catch (err) {
    console.error('ensureUserMoviesExist:', err.message)
  }
}

// ═════════════════════════ BACKGROUND UPDATE ═════════════════════════

async function updateOldMovies(batchSize = 41) {
  console.log(`🕒 Background update: batch=${batchSize}`)
  const startedAt = Date.now()

  try {
    const r = await pool.query(`
      SELECT tmdb_id, type FROM movies WHERE tmdb_id > 0
      ORDER BY COALESCE(last_checked_at, created_at) ASC
      LIMIT $1
    `, [batchSize])

    if (r.rows.length === 0) {
      console.log('✅ Nothing to update')
      return
    }

    const total = r.rows.length
    console.log(`🕒 Обновляю ${total} записей...`)

    let ok = 0
    let fail = 0
    const processed = []
    const seriesWithNewEpisodes = []

    for (let i = 0; i < total; i++) {
      const row = r.rows[i]
      const idx = `[${i + 1}/${total}]`
      const label = `${row.type}/${row.tmdb_id}`

      let beforeCount = null
      if (row.type === 'TV_SERIES') {
        const before = await pool.query(
          `SELECT COUNT(*)::int AS c FROM tmdb_episodes
           WHERE movie_id = $1 AND movie_type = 'TV_SERIES'`,
          [row.tmdb_id]
        )
        beforeCount = before.rows[0].c
      }

      try {
        await upsertTmdbMovie(row.tmdb_id, row.type)
        processed.push(row.tmdb_id)
        ok++
        console.log(`  ✓ ${idx} ${label}`)

        if (row.type === 'TV_SERIES' && beforeCount !== null) {
          const after = await pool.query(
            `SELECT COUNT(*)::int AS c FROM tmdb_episodes
             WHERE movie_id = $1 AND movie_type = 'TV_SERIES'`,
            [row.tmdb_id]
          )
          const afterCount = after.rows[0].c
          if (afterCount > beforeCount) {
            console.log(`    ↳ новых серий: ${afterCount - beforeCount}`)
            seriesWithNewEpisodes.push(row.tmdb_id)
          }
        }
      } catch (err) {
        fail++
        console.error(`  ❌ ${idx} ${label} — ${err.message}`)
      }

      if ((i + 1) % 25 === 0) {
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0)
        const pct = (((i + 1) / total) * 100).toFixed(0)
        console.log(`  ── прогресс ${i + 1}/${total} (${pct}%), прошло ${elapsed}s, ✅${ok} ❌${fail}`)
      }

      await new Promise(r => setTimeout(r, 250))
    }

    if (processed.length > 0) {
      await pool.query(
        'UPDATE movies SET last_checked_at_all = NOW() WHERE tmdb_id = ANY($1)',
        [processed]
      )
    }

    if (seriesWithNewEpisodes.length > 0) {
      console.log(`🔄 Пересчёт статусов для ${seriesWithNewEpisodes.length} сериалов с новыми сериями...`)
      let totalChecked = 0
      let totalChanged = 0
      for (const tmdbId of seriesWithNewEpisodes) {
        const res = await recalcStatusesForSeries(tmdbId)
        totalChecked += res.checked
        totalChanged += res.changed
      }
      console.log(`🔄 Пересчитано: проверено ${totalChecked} пользовательских статусов, изменено ${totalChanged}`)
    }

    const dur = ((Date.now() - startedAt) / 1000).toFixed(0)
    console.log(`🏁 Done: ✅ ${ok} / ❌ ${fail} за ${dur}s`)
  } catch (err) {
    console.error('updateOldMovies:', err)
  }
}

async function checkAndUpdateOnStartup() {
  try {
    const r = await pool.query('SELECT MAX(last_checked_at_all) AS lu FROM movies')
    const last = r.rows[0]?.lu
    const now = Date.now()
    let batch = 41

    if (!last) {
      console.log('🕒 Фон. обновление: никогда не запускалось → batch=984')
      batch = 984
    } else {
      const dh = (now - new Date(last).getTime()) / (1000 * 60 * 60)
      console.log(`🕒 Фон. обновление: последнее было ${dh.toFixed(2)}ч назад`)
      if (dh < 1) {
        console.log('🕒 Прошло меньше 1ч — пропускаю (так задумано)')
        return
      }
      if (dh >= 24) {
        batch = 984
        console.log(`🕒 Прошло ≥ 24ч → batch=984`)
      } else {
        batch = Math.min(984, Math.floor(dh * 41))
        console.log(`🕒 batch=${batch} (${dh.toFixed(2)}ч × 41)`)
      }
    }
    await updateOldMovies(batch)
  } catch (err) {
    console.error('checkAndUpdateOnStartup:', err)
  }
}

setTimeout(async () => {
  await ensureUserMoviesExist()
  await checkAndUpdateOnStartup()
}, 10000)

httpServer.listen(process.env.PORT, () => {
  console.log(`Server on port ${process.env.PORT}`)
})