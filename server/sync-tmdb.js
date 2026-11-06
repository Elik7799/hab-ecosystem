require('dotenv').config()
const { Pool } = require('pg')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

const TMDB_TOKEN = process.env.TMDB_ACCESS_TOKEN
const TMDB_BASE = 'https://api.themoviedb.org/3'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findTmdbId(nameRu, nameEn, year, type) {
  const searchType = (type === 'TV_SERIES' || type === 'MINI_SERIES') ? 'tv' : 'movie'
  
  // Пробуем поиск по русскому названию, потом по английскому
  const queries = [nameRu, nameEn].filter(Boolean)

  for (const query of queries) {
    const url = `${TMDB_BASE}/search/${searchType}?query=${encodeURIComponent(query)}&year=${year || ''}&language=ru-RU`
    
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${TMDB_TOKEN}` } })
      const data = await res.json()
      
      if (data.results && data.results.length > 0) {
        // Берем первый результат
        const bestMatch = data.results[0]
        
        // Получаем IMDb ID
        const detailsUrl = `${TMDB_BASE}/${searchType}/${bestMatch.id}?append_to_response=external_ids`
        const detailsRes = await fetch(detailsUrl, { headers: { Authorization: `Bearer ${TMDB_TOKEN}` } })
        const details = await detailsRes.json()
        
        return { 
          tmdbId: bestMatch.id, 
          imdbId: details.external_ids?.imdb_id || null 
        }
      }
    } catch (err) {
      console.error('Ошибка поиска:', err.message)
    }
    await sleep(200)
  }
  return null
}

async function syncAll() {
  console.log('🚀 Начинаем поиск TMDB ID...')
  
  const { rows } = await pool.query(`
    SELECT kinopoisk_id, name_ru, name_en, year, type 
    FROM movies 
    WHERE tmdb_id IS NULL 
    ORDER BY kinopoisk_id ASC
  `)

  console.log(`Найдено ${rows.length} фильмов без TMDB ID`)

  let success = 0
  let failed = 0

  for (let i = 0; i < rows.length; i++) {
    const movie = rows[i]
    const match = await findTmdbId(movie.name_ru, movie.name_en, movie.year, movie.type)
    
    if (match) {
      await pool.query(
        `UPDATE movies SET tmdb_id = $1, imdb_id = COALESCE(imdb_id, $2), tmdb_last_synced_at = NOW() WHERE kinopoisk_id = $3`,
        [match.tmdbId, match.imdbId, movie.kinopoisk_id]
      )
      console.log(`[${i+1}/${rows.length}] ✅ ${movie.name_ru} -> TMDB: ${match.tmdbId}`)
      success++
    } else {
      console.log(`[${i+1}/${rows.length}] ❌ Не найден: ${movie.name_ru}`)
      failed++
    }
    
    // Пауза, чтобы не превысить лимиты TMDB (50 запросов в секунду)
    await sleep(150)
  }

  console.log(`🏁 Готово! Успешно: ${success}, Не найдено: ${failed}`)
  process.exit(0)
}

syncAll()