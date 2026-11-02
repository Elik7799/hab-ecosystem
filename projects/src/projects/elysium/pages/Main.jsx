import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/ElysiumAuthContext'
import { getMovieName } from '../../../utils/ElysiumMovieName'
import { MovieGridSkeleton } from '../components/ElysiumSkeleton'
import { showError } from '../../../utils/ElysiumToast'

const API_URL_BACKEND = 'https://hab-ecosystem.onrender.com/api'
const PAGE_SIZE = 20

const CATEGORIES = [
  { value: 'MARVEL', label: 'Киновселенная MARVEL' },
  { value: 'TOP_POPULAR_ALL', label: 'Популярное (все)' },
  { value: 'TOP_POPULAR_MOVIES', label: 'Популярные фильмы' },
  { value: 'POPULAR_SERIES', label: 'Популярные сериалы' },
  { value: 'TOP_250_TV_SHOWS', label: 'Топ 250 сериалов' },
  { value: 'TOP_250_MOVIES', label: 'Топ 250 фильмов' },
]

const FILTERS = [
  { value: 'ALL', label: 'Все' },
  { value: 'FILM', label: 'Фильмы' },
  { value: 'TV_SERIES', label: 'Сериалы' },
  { value: 'MINI_SERIES', label: 'Мини-сериалы' },
  { value: 'VIDEO', label: 'Видео' },
  { value: 'TV_SHOW', label: 'ТВ-Шоу' },
]

export default function ElysiumMain() {
  const { token } = useAuth()

  const [query, setQuery] = useState('')
  const [movies, setMovies] = useState([])
  const [filter, setFilter] = useState('ALL')
  const [category, setCategory] = useState('MARVEL')
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
        // Передаем category и type (filter) в запросе
        const res = await fetch(
          `${API_URL_BACKEND}/kinopoisk/main?page=${pageNum}&limit=${PAGE_SIZE}&category=${category}&type=${filter}`,
          { headers: { Authorization: `Bearer ${token}` } }
        )

        if (!res.ok) throw new Error('Ошибка загрузки')

        const data = await res.json()

        // Для API-категорий (TOP_250 и т.д.) фильтрация по типу происходит на клиенте,
        // так как API не поддерживает type в collections.
        let items = data.items || []
        if (category !== 'MARVEL' && filter !== 'ALL') {
          items = items.filter((m) => m.type === filter)
        }

        if (append) {
          setMovies((prev) => [...prev, ...items])
        } else {
          setMovies(items)
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
    [token, category, filter]
  )

  // Сброс при смене категории или фильтра
  useEffect(() => {
    if (!token || isSearching) return
    setMovies([])
    setPage(1)
    fetchPopular(1, false)
  }, [token, category, filter, fetchPopular, isSearching])

  const searchMovies = useCallback(
    async (keyword) => {
      if (!token) return

      setLoading(true)
      setError('')

      try {
        const res = await fetch(
          `${API_URL_BACKEND}/kinopoisk/search?keyword=${encodeURIComponent(keyword)}`,
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
    setCategory('MARVEL')
    fetchPopular(1, false)
  }

  const handleLoadMore = () => {
    if (loadingMore || !hasMore) return
    fetchPopular(page + 1, true)
  }

  const categoryName = CATEGORIES.find((c) => c.value === category)?.label || 'Киновселенная MARVEL'

  return (
    <div className="main-body">
      <h1 className="main-title">
        {isSearching ? 'Результаты поиска' : categoryName}
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

      {!isSearching && (
        <>
          <div className="main-category-row">
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="main-select"
            >
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
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
        </>
      )}

      {loading && <MovieGridSkeleton count={20} />}
      {error && <p className="main-state">{error}</p>}

      {!loading && !error && movies.length > 0 && (
        <>
          <div className="main-moviesgrid">
            {movies.map((movie) => (
              <Link
                key={movie.kinopoiskId || movie.filmId}
                to={`/elysium/movie/${movie.kinopoiskId || movie.filmId}`}
                className={`main-moviecard status-${movie.status || 'not_watched'}`}
              >
                <img
                  src={movie.posterUrlPreview || 'https://kinopoiskapiunofficial.tech/images/posters/kp/no-poster.png'}
                  alt={getMovieName(movie)}
                  className="main-movieposter"
                  loading="lazy"
                  onError={(e) => { e.target.src = 'https://kinopoiskapiunofficial.tech/images/posters/kp/no-poster.png' }}
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

      {!loading && !error && movies.length === 0 && isSearching && query.trim() && (
        <p className="main-state">Ничего не найдено</p>
      )}

      {!loading && !error && movies.length === 0 && !isSearching && (
        <p className="main-state">В этой категории ничего нет</p>
      )}
    </div>
  )
}