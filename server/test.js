require('dotenv').config()
const { Pool } = require('pg')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

const TMDB_TOKEN = process.env.TMDB_ACCESS_TOKEN
const TMDB_BASE = 'https://api.themoviedb.org/3'
const IMAGE_BASE = 'https://image.tmdb.org/t/p/'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function tmdbFetch(url) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TMDB_TOKEN}` },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function syncMovie(tmdbId) {
  try {
    // 1. Пытаемся получить как сериал
    let data, isTV = false
    try {
      data = await tmdbFetch(`${TMDB_BASE}/tv/${tmdbId}?language=ru-RU&append_to_response=external_ids`)
      isTV = true
    } catch (e) {
      // Если не сериал, получаем как фильм
      data = await tmdbFetch(`${TMDB_BASE}/movie/${tmdbId}?language=ru-RU&append_to_response=external_ids`)
    }

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
    const type = isTV ? 'TV_SERIES' : 'FILM'

    // 2. Обновляем таблицу movies
    await pool.query(`
      UPDATE movies SET
        name_ru = $1, name_en = $2, name_original = $3, year = $4, type = $5,
        poster_url = $6, poster_url_preview = $7, rating_imdb = $8,
        description = $9, film_length = $10, slogan = $11, imdb_id = $12,
        tmdb_last_synced_at = NOW()
      WHERE tmdb_id = $13
    `, [title, originalTitle, originalTitle, year, type, posterUrl, posterPreview, rating, description, filmLength, slogan, imdbId, tmdbId])

    // 3. Жанры
    await pool.query('DELETE FROM movie_genres WHERE movie_id = $1', [tmdbId])
    for (const g of data.genres || []) {
      await pool.query('INSERT INTO movie_genres (movie_id, genre) VALUES ($1, $2) ON CONFLICT DO NOTHING', [tmdbId, g.name])
    }

    // 4. Страны
    await pool.query('DELETE FROM movie_countries WHERE movie_id = $1', [tmdbId])
    for (const c of data.production_countries || []) {
      await pool.query('INSERT INTO movie_countries (movie_id, country) VALUES ($1, $2) ON CONFLICT DO NOTHING', [tmdbId, c.name])
    }

    // 5. Сезоны и эпизоды
    if (isTV && data.seasons) {
      const validSeasons = data.seasons.filter(s => s.season_number > 0)
      for (const season of validSeasons) {
        try {
          const seasonData = await tmdbFetch(`${TMDB_BASE}/tv/${tmdbId}/season/${season.season_number}?language=ru-RU`)
          for (const ep of seasonData.episodes || []) {
            if (ep.episode_number == null) continue
            await pool.query(
              `INSERT INTO tmdb_episodes (movie_id, season_number, episode_number, name_ru, air_date, overview, tmdb_episode_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT (movie_id, season_number, episode_number) DO UPDATE SET
                 name_ru = EXCLUDED.name_ru, air_date = EXCLUDED.air_date, overview = EXCLUDED.overview`,
              [tmdbId, ep.season_number, ep.episode_number, ep.name || null, ep.air_date || null, ep.overview || null, ep.id]
            )
          }
          await sleep(100) // Пауза между сезонами
        } catch (err) {
          console.error(`  ⚠️ Ошибка сезона ${season.season_number}: ${err.message}`)
        }
      }
    }

    return true
  } catch (err) {
    console.error(`💥 Ошибка для ${tmdbId}: ${err.message}`)
    return false
  }
}

async function syncAll() {
  console.log('🚀 Запуск полной синхронизации из TMDB...')
  
  const { rows } = await pool.query('SELECT tmdb_id FROM movies ORDER BY tmdb_id ASC')
  console.log(`Найдено ${rows.length} фильмов/сериалов.\n`)

  let success = 0
  let failed = 0

  for (let i = 0; i < rows.length; i++) {
    const tmdbId = rows[i].tmdb_id
    process.stdout.write(`[${i + 1}/${rows.length}] ID ${tmdbId}... `)
    
    const ok = await syncMovie(tmdbId)
    if (ok) {
      console.log('✅')
      success++
    } else {
      console.log('❌')
      failed++
    }

    await sleep(100) // 100 мс = 10 запросов в секунду (безопасно)
  }

  console.log(`\n🏁 Синхронизация завершена!`)
  console.log(`✅ Успешно: ${success}`)
  console.log(`❌ Ошибок: ${failed}`)
  process.exit(0)
}

syncAll()