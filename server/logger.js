const fs = require('fs')
const path = require('path')

const LOG_PATH = path.join(__dirname, 'update.log')

// Записать строку в лог
function logUpdate(message) {
  const timestamp = new Date().toISOString()
  const line = `[${timestamp}] ${message}\n`

  // В консоль
  console.log(message)

  // В файл
  try {
    fs.appendFileSync(LOG_PATH, line)
  } catch (err) {
    console.error('Ошибка записи в лог:', err.message)
  }
}

// Начать сессию обновления
function logSessionStart(count) {
  logUpdate('')
  logUpdate('═══════════════════════════════════════')
  logUpdate(`🚀 НАЧАЛО ОБНОВЛЕНИЯ (${count} фильмов)`)
  logUpdate('═══════════════════════════════════════')
}

// Завершить сессию
function logSessionEnd(success, failed, stopped = false) {
  logUpdate('───────────────────────────────────────')
  logUpdate(`✅ Успешно: ${success}`)
  logUpdate(`❌ Ошибок: ${failed}`)
  if (stopped) logUpdate('⚠️  Прервано из-за лимита API')
  logUpdate(`🏁 ЗАВЕРШЕНО`)
  logUpdate('═══════════════════════════════════════')
  logUpdate('')
}

// Логировать успех
function logSuccess(movie) {
  const name = movie.nameRu || movie.nameEn || 'Без названия'
  const year = movie.year || '—'
  logUpdate(`  ✓ ${name} (${year})`)
}

// Логировать ошибку
function logError(id, error) {
  logUpdate(`  ✗ ID ${id}: ${error}`)
}

// Логировать предупреждение
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