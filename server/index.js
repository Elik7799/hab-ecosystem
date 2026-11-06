require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const KINOPOISK_DEV_TOKEN = process.env.KINOPOISK_DEV_TOKEN;
const KINOPOISK_DEV_BASE = 'https://api.kinopoisk.dev/v1.4';

// Заглушка для TMDB. ID 0 в TMDB считается невалидным, поэтому безопасен.
// Если в вашей схеме есть CHECK (tmdb_id > 0), замените на -1.
const TMDB_ID_PLACEHOLDER = 0;
// Для IMDb оставляем NULL (поле допускает NULL, как видно из COALESCE в основном коде).
// Если поле NOT NULL — используйте пустую строку ''.
const IMDB_ID_PLACEHOLDER = null;

async function fetchExternalIds(kinopoiskId) {
  const url = `${KINOPOISK_DEV_BASE}/movie?id=${kinopoiskId}`;
  const res = await fetch(url, {
    headers: {
      'X-API-KEY': KINOPOISK_DEV_TOKEN,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    if (res.status === 404) return null; // фильм не найден в kinopoisk.dev
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  const data = await res.json();
  // Эндпоинт поиска возвращает массив, поэтому берём первый элемент.
  const movie = Array.isArray(data) ? data[0] : data;
  if (!movie) return null;

  let tmdbId = movie.externalId?.tmdb;
  if (Array.isArray(tmdbId)) tmdbId = tmdbId[0];
  let imdbId = movie.externalId?.imdb;
  if (Array.isArray(imdbId)) imdbId = imdbId[0];

  return {
    tmdbId: tmdbId != null ? Number(tmdbId) : null,
    imdbId: imdbId != null ? String(imdbId) : null,
  };
}

async function main() {
  const { rows } = await pool.query(`
    SELECT kinopoisk_id
    FROM movies
    WHERE tmdb_id IS NULL
    ORDER BY kinopoisk_id
  `);

  console.log(`Найдено ${rows.length} фильмов без tmdb_id`);

  for (let i = 0; i < rows.length; i++) {
    const { kinopoisk_id } = rows[i];
    try {
      const ids = await fetchExternalIds(kinopoisk_id);

      const tmdbId = ids?.tmdbId ?? TMDB_ID_PLACEHOLDER;
      const imdbId = ids?.imdbId ?? IMDB_ID_PLACEHOLDER;

      await pool.query(
        `UPDATE movies SET tmdb_id = $1, imdb_id = $2 WHERE kinopoisk_id = $3`,
        [tmdbId, imdbId, kinopoisk_id]
      );

      console.log(
        `[${i + 1}/${rows.length}] kinopoisk_id ${kinopoisk_id}: ` +
        `tmdb_id=${tmdbId}, imdb_id=${imdbId}`
      );
    } catch (err) {
      console.error(
        `[${i + 1}/${rows.length}] Ошибка для kinopoisk_id ${kinopoisk_id}:`,
        err.message
      );
    }

    // Задержка, чтобы не превысить лимиты kinopoisk.dev
    await new Promise(r => setTimeout(r, 200));
  }

  console.log('✅ Готово');
  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});