export function getMovieName(movie) {
  if (!movie) return '—'
  return movie.nameRu || movie.nameEn || movie.nameOriginal || 'Без названия'
}

export function getMovieYear(movie) {
  if (!movie) return ''
  return movie.year || ''
}