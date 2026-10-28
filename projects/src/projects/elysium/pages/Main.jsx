import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/ElysiumAuthContext'
import { getMovieName } from '../../../utils/ElysiumMovieName'
import { MovieGridSkeleton } from '../components/ElysiumSkeleton'
import { showError } from '../../../utils/ElysiumToast'

const API_URL_BACKEND = 'https://hab-ecosystem.onrender.com/api'
const PAGE_SIZE = 20

const FILTERS = [
  { value: 'ALL', label: 'Все' },
  { value: 'FILM', label: 'Фильмы' },
  { value: 'TV_SERIES', label: 'Сериалы' },
  { value: 'MINI_SERIES', label: 'Мини-сериалы' },
]

export default function ElysiumMain() {
  const { token } = useAuth()

  const [query, setQuery] = useState('')
  const [movies, setMovies] = useState([])
  const [filter, setFilter] = useState('ALL')
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [isSearching, setIsSearching] = useState(false)

  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [totalPages, setTotalPages] = useState(1)

  const fetchPopular = useCallback(
    async (pageNum, append = false) => {
      if (!token) return

      if (append) setLoadingMore(true)
      else setLoading(true)

      setError('')

      try {
        const res = await fetch(
          `${API_URL_BACKEND}/kinopoisk/main?page=${pageNum}&limit=${PAGE_SIZE}`,
          { headers: { Authorization: `Bearer ${token}` } }
        )

        if (!res.ok) throw new Error('Ошибка загрузки')

        const data = await res.json()

        if (append) {
          setMovies((prev) => [...prev, ...(data.items || [])])
        } else {
          setMovies(data.items || [])
        }

        setPage(data.page || pageNum)
        setHasMore(data.hasMore || false)
        setTotalPages(data.totalPages || 1)
      } catch (err) {
        setError('Не удалось загрузить фильмы. Попробуйте позже.')
        showError('Не удалось загрузить фильмы')
        console.error(err)
      } finally {
        setLoading(false)
        setLoadingMore(false)
      }
    },
    [token]
  )

  useEffect(() => {
    if (!token) return
    fetchPopular(1, false)
  }, [token, fetchPopular])

  const searchMovies = useCallback(
    async (keyword) => {
      if (!token) return

      setLoading(true)
      setError('')

      try {
        const res = await fetch(
          `${API_URL_BACKEND}/kinopoisk/search?keyword=${encodeURIComponent(
            keyword
          )}`,
          { headers: { Authorization: `Bearer ${token}` } }
        )

        if (!res.ok) throw new Error('Ошибка поиска')

        const data = await res.json()
        setMovies(data.films || [])
        setHasMore(false)
        setPage(1)
        setTotalPages(1)
      } catch (err) {
        setError('Не удалось выполнить поиск.')
        showError('Ошибка поиска')
        console.error(err)
      } finally {
        setLoading(false)
      }
    },
    [token]
  )

  useEffect(() => {
    if (!isSearching) return

    if (!query.trim()) {
      setIsSearching(false)
      setFilter('ALL')
      fetchPopular(1, false)
      return
    }

    const delay = setTimeout(() => {
      searchMovies(query)
    }, 500)

    return () => clearTimeout(delay)
  }, [query, isSearching, searchMovies, fetchPopular])

  const handleSearchChange = (e) => {
    setQuery(e.target.value)
    setIsSearching(true)
  }

  const handleClearSearch = () => {
    setQuery('')
    setIsSearching(false)
    setFilter('ALL')
    fetchPopular(1, false)
  }

  const handleLoadMore = () => {
    if (loadingMore || !hasMore) return
    fetchPopular(page + 1, true)
  }

  const filteredMovies = movies.filter((movie) => {
    if (filter === 'ALL') return true
    return movie.type === filter
  })

  return (
    <div className="main-body">
      <h1 className="main-title">
        {isSearching ? 'Результаты поиска' : 'Мои фильмы'}
      </h1>

      <div className="main-searchbox">
        <input
          type="text"
          className="main-searchinput"
          placeholder="Введите название фильма..."
          value={query}
          onChange={handleSearchChange}
        />
        {query && (
          <button
            type="button"
            className="main-searchclear"
            onClick={handleClearSearch}
            aria-label="Очистить поиск"
          >
            ✕
          </button>
        )}
      </div>

      <div className="main-filters">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            className={
              filter === f.value ? 'main-filterbtn active' : 'main-filterbtn'
            }
            onClick={() => setFilter(f.value)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading && <MovieGridSkeleton count={20} />}
      {error && <p className="main-state">{error}</p>}

      {!loading && !error && filteredMovies.length > 0 && (
        <>
          <div className="main-moviesgrid">
            {filteredMovies.map((movie) => (
              <Link
                key={movie.kinopoiskId || movie.filmId}
                to={`/elysium/movie/${movie.kinopoiskId || movie.filmId}`}
                className={`main-moviecard status-${movie.status || 'not_watched'}`} // <-- Добавили класс
              >
                <img
                  src={movie.posterUrlPreview}
                  alt={getMovieName(movie)}
                  className="main-movieposter"
                  loading="lazy"
                />
                <div className="main-movieinfo">
                  <p className="main-moviename">{getMovieName(movie)}</p>
                  <p className="main-movieyear">{movie.year}</p>
                </div>
              </Link>
            ))}
          </div>

          {!isSearching && hasMore && (
            <div className="main-loadmore">
              <button
                type="button"
                className="main-loadmore-btn"
                onClick={handleLoadMore}
                disabled={loadingMore}
              >
                {loadingMore ? 'Загрузка...' : 'Показать ещё'}
              </button>
              <p className="main-loadmore-info">
                Страница {page} из {totalPages}
              </p>
            </div>
          )}
        </>
      )}

      {!loading &&
        !error &&
        filteredMovies.length === 0 &&
        movies.length > 0 && (
          <p className="main-state">В этой категории ничего нет</p>
        )}

      {!loading &&
        !error &&
        movies.length === 0 &&
        isSearching &&
        query.trim() && (
          <p className="main-state">Ничего не найдено</p>
        )}

      {!loading && !error && movies.length === 0 && !isSearching && (
        <p className="main-state">Фильмов пока нет</p>
      )}
    </div>
  )
}