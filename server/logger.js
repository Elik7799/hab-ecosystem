const fs = require('fs')
const path = require('path')

const LOG_PATH = path.join(__dirname, 'update.log')

function logUpdate(message) {
  const timestamp = new Date().toISOString()
  const line = `[${timestamp}] ${message}\n`

  console.log(message)

  try {
    fs.appendFileSync(LOG_PATH, line)
  } catch (err) {
    console.error('Ошибка записи в лог:', err.message)
  }
}

function logSessionStart(count) {
  logUpdate('')
  logUpdate('═══════════════════════════════════════')
  logUpdate(`🚀 НАЧАЛО ОБНОВЛЕНИЯ (${count} фильмов)`)
  logUpdate('═══════════════════════════════════════')
}

function logSessionEnd(success, failed, stopped = false) {
  logUpdate('───────────────────────────────────────')
  logUpdate(`✅ Успешно: ${success}`)
  logUpdate(`❌ Ошибок: ${failed}`)
  if (stopped) logUpdate('⚠️  Прервано из-за лимита API')
  logUpdate(`🏁 ЗАВЕРШЕНО`)
  logUpdate('═══════════════════════════════════════')
  logUpdate('')
}

function logSuccess(movie) {
  const name = movie.nameRu || movie.nameEn || 'Без названия'
  const year = movie.year || '—'
  logUpdate(`  ✓ ${name} (${year})`)
}

function logError(id, error) {
  logUpdate(`  ✗ ID ${id}: ${error}`)
}

function logWarning(message) {
  logUpdate(`  ⚠️  ${message}`)
}

module.exports = {
  logUpdate,
  logSessionStart,
  logSessionEnd,
  logSuccess,
  logError,
  logWarning,
}