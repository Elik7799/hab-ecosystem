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
    let data, isTV = false
    try {
      data = await tmdbFetch(`${TMDB_BASE}/tv/${tmdbId}?language=ru-RU&append_to_response=external_ids`)
      isTV = true
    } catch (e) {
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

    // Убрали tmdb_last_synced_at, оставили last_checked_at
    await pool.query(`
      UPDATE movies SET
        name_ru = $1, name_en = $2, name_original = $3, year = $4, type = $5,
        poster_url = $6, poster_url_preview = $7, rating_imdb = $8,
        description = $9, film_length = $10, slogan = $11, imdb_id = $12,
        last_checked_at = NOW()
      WHERE tmdb_id = $13
    `, [title, originalTitle, originalTitle, year, type, posterUrl, posterPreview, rating, description, filmLength, slogan, imdbId, tmdbId])

    await pool.query('DELETE FROM movie_genres WHERE movie_id = $1', [tmdbId])
    for (const g of data.genres || []) {
      await pool.query('INSERT INTO movie_genres (movie_id, genre) VALUES ($1, $2) ON CONFLICT DO NOTHING', [tmdbId, g.name])
    }

    await pool.query('DELETE FROM movie_countries WHERE movie_id = $1', [tmdbId])
    for (const c of data.production_countries || []) {
      await pool.query('INSERT INTO movie_countries (movie_id, country) VALUES ($1, $2) ON CONFLICT DO NOTHING', [tmdbId, c.name])
    }

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
          await sleep(100)
        } catch (err) {
          console.log(`\n  ⚠️ Ошибка сезона ${season.season_number}: ${err.message}`)
        }
      }
    }
    return true
  } catch (err) {
    console.log(`\n  💥 Ошибка: ${err.message}`)
    return false
  }
}

async function syncAll() {
  console.log('🚀 Запуск синхронизации пачкой по 150...')
  
  // Берем 150 фильмов с самыми старыми датами (или NULL)
  const { rows } = await pool.query(`
    SELECT tmdb_id 
    FROM movies 
    WHERE tmdb_id > 0 
    ORDER BY last_checked_at ASC NULLS FIRST 
    LIMIT 150
  `)
  
  if (rows.length === 0) {
    console.log('✅ Все фильмы уже обновлены!')
    return
  }

  console.log(`Найдено ${rows.length} фильмов для обновления.\n`)

  let success = 0, failed = 0

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

    await sleep(150) // Пауза между запросами
  }

  console.log(`\n🏁 Пачка завершена! ✅ ${success} / ❌ ${failed}`)
  process.exit(0)
}

syncAll()