export function getMovieName(movie) {
  if (!movie) return '—'
  return movie.nameRu || movie.nameOriginal || 'Без названия'
}

export function getMovieYear(movie) {
  if (!movie) return ''
  return movie.year || ''
}

export function getMoviePath(movie) {
  if (!movie) return null
  const id = movie.kinopoiskId ?? movie.tmdbId
  if (!id) return null
  return movie.type === 'TV_SERIES'
    ? `/elysium/serial/${id}`
    : `/elysium/movie/${id}`
}

export function dbTypeToPathType(dbType) {
  return dbType === 'TV_SERIES' ? 'tv' : 'movie'
}