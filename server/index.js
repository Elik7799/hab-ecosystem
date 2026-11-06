require('dotenv').config()
const express = require('express')
const { Pool } = require('pg')

const app = express()
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

const TMDB_TOKEN = process.env.TMDB_ACCESS_TOKEN
const TMDB_BASE = 'https://api.themoviedb.org/3'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const state = {
  startedAt: null,
  total: 0,
  processed: 0,
  success: 0,
  notFound: 0,
  skipped: 0,
  errors: 0,
  finished: false,
  currentMovie: null,
  fatalError: null,
}

async function tmdbFetch(url) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TMDB_TOKEN}` },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`TMDB HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  return res.json()
}

async function findTmdbId(nameRu, nameEn, nameOriginal, year, type) {
  const searchType =
    type === 'TV_SERIES' || type === 'MINI_SERIES' ? 'tv' : 'movie'

  const queries = [nameRu, nameEn, nameOriginal].filter(
    (q) => q && q.trim() !== '' && q !== 'null'
  )

  for (const query of queries) {
    try {
      const url = `${TMDB_BASE}/search/${searchType}?query=${encodeURIComponent(query)}&year=${year || ''}&language=ru-RU`
      const data = await tmdbFetch(url)

      if (data.results && data.results.length > 0) {
        const best = data.results[0]
        let imdbId = null
        try {
          const detailsUrl = `${TMDB_BASE}/${searchType}/${best.id}?append_to_response=external_ids`
          const details = await tmdbFetch(detailsUrl)
          imdbId = details.external_ids?.imdb_id || null
        } catch (e) {
          // не критично
        }
        return { tmdbId: best.id, imdbId }
      }
    } catch (err) {
      console.error(`  ⚠️  "${query}": ${err.message}`)
      if (err.cause) {
        console.error(`      cause: ${err.cause.code || err.cause.message}`)
      }
    }
    await sleep(200)
  }
  return null
}

async function runSync() {
  try {
    state.startedAt = new Date().toISOString()
    console.log('🚀 Начинаем поиск TMDB ID...\n')

    if (!TMDB_TOKEN) {
      state.fatalError = 'TMDB_ACCESS_TOKEN не задан'
      state.finished = true
      console.error('❌ TMDB_ACCESS_TOKEN не задан')
      return
    }

    // Пинг TMDB — сразу поймём, доступен ли он с Render
    console.log('🔍 Проверка доступности TMDB...')
    try {
      const ping = await tmdbFetch(`${TMDB_BASE}/movie/550?language=ru-RU`)
      console.log(`✅ TMDB доступен (тест: "${ping.title}")\n`)
    } catch (e) {
      console.error('❌ TMDB НЕДОСТУПЕН:', e.message)
      if (e.cause) console.error('   cause:', e.cause.code || e.cause.message)
      state.fatalError = `TMDB недоступен: ${e.message}`
      state.finished = true
      return
    }

    const { rows } = await pool.query(`
      SELECT kinopoisk_id, name_ru, name_en, name_original, year, type
      FROM movies
      WHERE tmdb_id IS NULL
      ORDER BY kinopoisk_id ASC
    `)

    state.total = rows.length
    console.log(`Найдено ${rows.length} фильмов без TMDB ID\n`)

    for (let i = 0; i < rows.length; i++) {
      const movie = rows[i]
      state.currentMovie = movie.name_ru || movie.kinopoisk_id

      const names = [movie.name_ru, movie.name_en, movie.name_original].filter(
        (n) => n && n.trim() !== '' && n !== 'null'
      )

      if (names.length === 0) {
        console.log(
          `[${i + 1}/${rows.length}] ⏭️  Пропуск (нет названий): id=${movie.kinopoisk_id}`
        )
        state.skipped++
        state.processed++
        continue
      }

      const match = await findTmdbId(
        movie.name_ru,
        movie.name_en,
        movie.name_original,
        movie.year,
        movie.type
      )

      if (match) {
        try {
          await pool.query(
            `UPDATE movies
             SET tmdb_id = $1,
                 imdb_id = COALESCE(imdb_id, $2),
                 tmdb_last_synced_at = NOW()
             WHERE kinopoisk_id = $3`,
            [match.tmdbId, match.imdbId, movie.kinopoisk_id]
          )
          console.log(
            `[${i + 1}/${rows.length}] ✅ ${names[0]} → TMDB: ${match.tmdbId}`
          )
          state.success++
        } catch (e) {
          console.error(
            `[${i + 1}/${rows.length}] ❌ Ошибка сохранения "${names[0]}": ${e.message}`
          )
          state.errors++
        }
      } else {
        console.log(`[${i + 1}/${rows.length}] ❌ Не найден: ${names[0]}`)
        state.notFound++
      }

      state.processed++
      await sleep(150)
    }

    state.finished = true
    console.log('\n🏁 ГОТОВО!')
    console.log(`   ✅ Успешно:                    ${state.success}`)
    console.log(`   ❌ Не найдено:                 ${state.notFound}`)
    console.log(`   ⏭️  Пропущено (нет названий):  ${state.skipped}`)
    console.log(`   💥 Ошибок сохранения:          ${state.errors}`)
    console.log('\n👉 Теперь можно вернуть оригинальный index.js')
  } catch (err) {
    state.fatalError = err.message
    state.finished = true
    console.error('💥 Фатальная ошибка:', err)
  }
}

app.get('/status', (req, res) => res.json(state))
app.get('/health', (req, res) => res.send('OK'))

const PORT = process.env.PORT || 10000
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`)
  console.log('Запускаю синхронизацию в фоне...\n')
  runSync()
})