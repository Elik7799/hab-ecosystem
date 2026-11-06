require('dotenv').config()
const { Pool } = require('pg')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

const TMDB_TOKEN = process.env.TMDB_ACCESS_TOKEN
const TMDB_BASE = 'https://api.themoviedb.org/3'
const IMAGE_BASE = 'https://image.tmdb.org/t/p/'
  
// { id, type } — type обязателен, потому что tmdb_id не уникален между movie и tv.
const MAIN_MOVIES = [  
  // 2027
  { id: 1003598, type: 'FILM' },     // Мстители: Секретные войны

  // 2026 
  { id: 1003596, type: 'FILM' },     // Мстители: Доктор Дум
  { id: 213375, type: 'TV_SERIES' }, // Квест Вижна (сериал)
  { id: 969681, type: 'FILM' },      // Человек-паук: Новый день
  { id: 220102, type: 'TV_SERIES' }, // Паук-Нуар (сериал)
  { id: 1439930, type: 'FILM' },     // Каратель: Последнее убийство
  { id: 198178, type: 'TV_SERIES' }, // Чудо-человек (сериал)

  // 2025
  { id: 114471, type: 'TV_SERIES' }, // Железное сердце (сериал)
  { id: 617126, type: 'FILM' },      // Фантастическая четвёрка: Первые шаги
  { id: 986056, type: 'FILM' },      // Громовержцы*
  { id: 202555, type: 'TV_SERIES' }, // Сорвиголова: Рождённый заново (сериал)
  { id: 822119, type: 'FILM' },      // Капитан Америка: Новый мир

  // 2024
  { id: 539972, type: 'FILM' },      // Крейвен-охотник
  { id: 912649, type: 'FILM' },      // Веном: Последний танец
  { id: 138501, type: 'TV_SERIES' }, // Это всё Агата (сериал)
  { id: 533535, type: 'FILM' },      // Дэдпул и Росомаха
  { id: 634492, type: 'FILM' },      // Мадам Паутина
  { id: 122226, type: 'TV_SERIES' }, // Эхо (сериал)

  // 2023  
  { id: 609681, type: 'FILM' },      // Капитан Марвел 2
  { id: 114472, type: 'TV_SERIES' }, // Секретное вторжение (сериал)
  { id: 447365, type: 'FILM' },      // Стражи Галактики. Часть 3
  { id: 640146, type: 'FILM' },      // Человек-муравей и Оса: Квантомания

  // 2022
  { id: 774752, type: 'FILM' },     // Стражи Галактики: Праздничный спецвыпуск
  { id: 505642, type: 'FILM' },     // Чёрная пантера: Ваканда навеки
  { id: 894205, type: 'FILM' },     // Ночной оборотень
  { id: 92783, type: 'TV_SERIES' }, // Женщина-Халк (сериал)
  { id: 616037, type: 'FILM' },     // Тор: Любовь и гром
  { id: 92782, type: 'TV_SERIES' }, // Мисс Марвел (сериал)
  { id: 453395, type: 'FILM' },     // Доктор Стрэндж: В мультивселенной безумия
  { id: 526896, type: 'FILM' },     // Морбиус
  { id: 92749, type: 'TV_SERIES' }, // Лунный рыцарь (сериал)

  // 2021
  { id: 634649, type: 'FILM' },     // Человек-паук: Нет пути домой
  { id: 88329, type: 'TV_SERIES' }, // Соколиный глаз (сериал)
  { id: 524434, type: 'FILM' },     // Вечные
  { id: 580489, type: 'FILM' },     // Веном 2
  { id: 566525, type: 'FILM' },     // Шан-Чи и легенда десяти колец
  { id: 497698, type: 'FILM' },     // Чёрная вдова
  { id: 84958, type: 'TV_SERIES' }, // Локи (сериал)
  { id: 88396, type: 'TV_SERIES' }, // Сокол и Зимний солдат (сериал)
  { id: 85271, type: 'TV_SERIES' }, // ВандаВижн (сериал)

  // 2020
  { id: 88987, type: 'TV_SERIES' }, // Хелстром (сериал)
  { id: 340102, type: 'FILM' },     // Новые мутанты

  // 2019
  { id: 758025, type: 'FILM' },     // Список дел Питера
  { id: 429617, type: 'FILM' },     // Человек-паук: Вдали от дома
  { id: 320288, type: 'FILM' },     // Люди Икс: Тёмный Феникс
  { id: 299534, type: 'FILM' },     // Мстители: Финал
  { id: 299537, type: 'FILM' },     // Капитан Марвел

  // 2018
  { id: 335983, type: 'FILM' },     // Веном
  { id: 363088, type: 'FILM' },     // Человек-муравей и Оса
  { id: 66190, type: 'TV_SERIES' }, // Плащ и Кинжал (сериал)
  { id: 383498, type: 'FILM' },     // Дэдпул 2
  { id: 299536, type: 'FILM' },     // Мстители: Война бесконечности
  { id: 284054, type: 'FILM' },     // Чёрная пантера
  { id: 505945, type: 'FILM' },     // Команда Дэррила

  // 2017
  { id: 67466, type: 'TV_SERIES' }, // Беглецы (сериал)
  { id: 67178, type: 'TV_SERIES' }, // Каратель (сериал)
  { id: 284053, type: 'FILM' },     // Тор: Рагнарёк
  { id: 69629, type: 'TV_SERIES' }, // Одарённые (сериал)
  { id: 68716, type: 'TV_SERIES' }, // Сверхлюди (сериал)
  { id: 62285, type: 'TV_SERIES' }, // Защитники (сериал)
  { id: 315635, type: 'FILM' },     // Человек-паук: Возвращение домой
  { id: 283995, type: 'FILM' },     // Стражи Галактики. Часть 2
  { id: 62127, type: 'TV_SERIES' }, // Железный кулак (сериал)
  { id: 263115, type: 'FILM' },     // Логан
  { id: 67195, type: 'TV_SERIES' }, // Легион (сериал)
  { id: 558144, type: 'FILM' },     // Никаких добрых дел
  { id: 441829, type: 'FILM' },     // Команда Тора. Часть 2

  // 2016
  { id: 413279, type: 'FILM' },     // Команда Тора
  { id: 284052, type: 'FILM' },     // Доктор Стрэндж
  { id: 62126, type: 'TV_SERIES' }, // Люк Кейдж (сериал)
  { id: 246655, type: 'FILM' },     // Люди Икс: Апокалипсис
  { id: 271110, type: 'FILM' },     // Первый мститель: Противостояние
  { id: 293660, type: 'FILM' },     // Дэдпул

  // 2015 
  { id: 38472, type: 'TV_SERIES' }, // Джессика Джонс (сериал)
  { id: 166424, type: 'FILM' },     // Фантастическая четвёрка
  { id: 102899, type: 'FILM' },     // Человек-муравей
  { id: 99861, type: 'FILM' },     // Мстители: Эра Альтрона
  // { id: , type: 'TV_SERIES' }, // Сорвиголова (сериал)
  { id: 61550, type: 'TV_SERIES' }, // Агент Картер (сериал)

    // 2014
  // { id: , type: 'FILM' },    // Стражи Галактики
  // { id: , type: 'FILM' },    // Люди Икс: Дни минувшего будущего
  // { id: , type: 'FILM' },    // Новый Человек-паук: Высокое напряжение
  // { id: , type: 'FILM' },    // Первый мститель: Другая война
  { id: 253980, type: 'FILM' },  // Да здравствует король

  // 2013
  // { id: , type: 'FILM' },    // Тор 2: Царство тьмы
  // { id: , type: 'TV_SERIES' },    // Агенты «Щ.И.Т.» (сериал)
  // { id: , type: 'FILM' },    // Росомаха: Бессмертный
  // { id: , type: 'FILM' },    // Железный человек 3
  { id: 211387, type: 'FILM' },  // Агент Картер (короткометражка)

  // 2012
  // { id: , type: 'FILM' },    // Новый Человек-паук
  // { id: , type: 'FILM' },    // Образец 47
  // { id: , type: 'FILM' },    // Мстители
  // { id: , type: 'FILM' },    // Призрачный гонщик 2

  // 2011
  // { id: , type: 'FILM' },    // Забавный случай по дороге к молоту Тора
  // { id: , type: 'FILM' },    // Консультант
  // { id: , type: 'FILM' },    // Первый мститель
  // { id: , type: 'FILM' },    // Люди Икс: Первый класс
  // { id: , type: 'FILM' },    // Тор

  // 2010
  // { id: , type: 'FILM' },    // Железный человек 2

  // 2009
  // { id: , type: 'FILM' },    // Люди Икс: Начало. Росомаха

  // 2008
  // { id: , type: 'FILM' },    // Каратель: Территория войны
  // { id: , type: 'FILM' },    // Невероятный Халк
  // { id: , type: 'FILM' },    // Железный человек

  // 2007
  // { id: , type: 'FILM' },    // Фантастическая четвёрка: Вторжение Серебряного сёрфера
  // { id: , type: 'FILM' },    // Человек-паук 3: Враг в отражении
  // { id: , type: 'FILM' },    // Призрачный гонщик

  // 2006
  { id: 4619, type: 'TV_SERIES' },    // Блэйд (сериал)
  { id: 36668, type: 'FILM' },   // Люди Икс: Последняя битва

  // 2005
  // { id: , type: 'FILM' },    // Фантастическая четвёрка
  { id: 9947, type: 'FILM' },    // Электра

  // 2004
  // { id: , type: 'FILM' },    // Блэйд: Троица
  // { id: , type: 'FILM' },    // Человек-паук 2
  // { id: , type: 'FILM' },    // Каратель

  // 2003
  // { id: , type: 'FILM' },    // Халк
  // { id: , type: 'FILM' },    // Люди Икс 2
  // { id: , type: 'FILM' },    // Сорвиголова

  // 2002
  // { id: , type: 'FILM' },    // Человек-паук
  { id: 36586, type: 'FILM' },   // Блэйд 2

  // 2001
  { id: 1449, type: 'TV_SERIES' },    // Мутанты Икс (сериал)

  // 2000
  // { id: , type: 'FILM' },    // Люди Икс

  // 1998
  // { id: , type: 'FILM' },    // Блэйд

  // 1986
  // { id: , type: 'FILM' },    // Говард-утка
]

async function tmdbFetch(url) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TMDB_TOKEN}` },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function fetchAndSave(tmdbId, type) {
  try {
    const endpoint = type === 'TV_SERIES' ? 'tv' : 'movie'
    const isTV = type === 'TV_SERIES'
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
         rating_imdb, description, film_length, slogan, imdb_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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
        imdb_id = COALESCE(EXCLUDED.imdb_id, movies.imdb_id)
    `, [tmdbId, type, nameRu, nameOriginal, year, posterUrl, posterPreview,
        rating, description, filmLength, slogan, imdbId])
    return true
  } catch (err) {
    console.error(`  ✕ ${type}/${tmdbId}: ${err.message}`)
    return false
  }
}

async function fillMain() {
  console.log(`Filling main_movies (${MAIN_MOVIES.length})...`)
  await pool.query('DELETE FROM main_movies')

  let ok = 0, missing = 0
  for (let i = 0; i < MAIN_MOVIES.length; i++) {
    const { id, type } = MAIN_MOVIES[i]
    let r = await pool.query(
      'SELECT id FROM movies WHERE tmdb_id = $1 AND type = $2', [id, type]
    )
    if (r.rows.length === 0) {
      console.log(`  ⏳ ${type}/${id} — fetching...`)
      await fetchAndSave(id, type)
      r = await pool.query(
        'SELECT id FROM movies WHERE tmdb_id = $1 AND type = $2', [id, type]
      )
    }
    if (r.rows.length === 0) {
      console.log(`  ⚠ ${type}/${id} — failed, skip`)
      missing++
      continue
    }
    await pool.query(`
      INSERT INTO main_movies (movie_id, position) VALUES ($1, $2)
      ON CONFLICT (movie_id) DO UPDATE SET position = EXCLUDED.position
    `, [r.rows[0].id, i])
    ok++
  }
  console.log(`=== DONE: added ${ok}, skipped ${missing}`)
  await pool.end()
}

fillMain().catch(console.error)