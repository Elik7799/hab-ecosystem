import { useState, useRef, useEffect } from 'react'
import { RotateCcw, Users, Sun, Moon } from 'lucide-react'
import { Link } from 'react-router-dom'
import './cluedo.css'
import { useTheme } from '../../context/ThemeContext'

const SUSPECTS = ['Грин', 'Мастард', 'Оркид', 'Пикок', 'Плам', 'Скарлет']
const WEAPONS = ['Подсвечник', 'Кинжал', 'Труба', 'Револьвер', 'Статуя', 'Яд']
const ROOMS = [
  'Бальный зал', 'Бильярдная', 'Зимний сад', 'Столовая', 'Холл',
  'Кухня', 'Библиотека', 'Гостинная', 'Кабинет',
]

const STATUSES = ['', '✓', '✕', '•', '?', '??', '???', '1', '2', '3', '4', '5', '6', '7', '8', '9']

export default function CluedoApp() {
  const { theme, toggleTheme } = useTheme()
  const [playersCount, setPlayersCount] = useState(2)

  // Имена для ОСТАЛЬНЫХ игроков (без "Я")
  // playersCount = 2 → 1 имя (для второго игрока)
  // playersCount = 6 → 5 имён
  const [otherPlayers, setOtherPlayers] = useState(Array(1).fill(''))

  const [cells, setCells] = useState({})
  const [crossedRows, setCrossedRows] = useState({})

  const [popup, setPopup] = useState(null)
  const popupRef = useRef(null)

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (popupRef.current && !popupRef.current.contains(e.target)) {
        setPopup(null)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handlePlayersCountChange = (count) => {
    setPlayersCount(count)
    const othersCount = count - 1
    setOtherPlayers((prev) => {
      const next = [...prev]
      for (let i = 0; i < othersCount; i++) {
        if (next[i] === undefined) next[i] = ''
      }
      return next.slice(0, othersCount)
    })
    setCells({})
    setCrossedRows({})
  }

  const handleNameChange = (index, value) => {
    setOtherPlayers((prev) => {
      const next = [...prev]
      next[index] = value
      return next
    })
  }

  const handleCellClick = (e, blockId, rowName, playerIndex) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const key = `${blockId}-${rowName}-${playerIndex}`

    // Примерная высота попапа (в пикселях). У вас он с отступами и сеткой,
    // поэтому берем с запасом — около 250px.
    const POPUP_HEIGHT = 200
    const SPACE_BELOW = window.innerHeight - rect.bottom

    // Если места снизу меньше, чем высота попапа, открываем вверх
    const openAbove = SPACE_BELOW < POPUP_HEIGHT

    setPopup({
      key,
      x: rect.left + rect.width / 2,
      // Если открываем вверх, отнимаем высоту попапа от верхней границы ячейки
      y: openAbove ? rect.top - POPUP_HEIGHT : rect.bottom + 8,
      openAbove, // передаем флаг, чтобы можно было стилизовать (необязательно)
      currentValue: cells[key] || '',
    })
  }

  const handleSelectValue = (value) => {
    if (!popup) return
    setCells((prev) => ({ ...prev, [popup.key]: value }))
    setPopup(null)
  }

  const handleRowClick = (blockId, rowName) => {
    const key = `${blockId}-${rowName}`
    setCrossedRows((prev) => {
      const current = prev[key] || 'default'
      let next = 'default'

      if (current === 'default') next = 'crossed'
      else if (current === 'crossed') next = 'outlined'

      return { ...prev, [key]: next }
    })
  }

  const handleNewGame = () => {
    setCells({})
    setCrossedRows({})
    setPopup(null)
  }

  const getCellClass = (value) => {
    let cls = 'cluedo-cell-value'
    if (value === '✓') cls += ' cluedo-cell-yes'
    else if (value === '✕') cls += ' cluedo-cell-no'
    else if (value === '•') cls += ' cluedo-cell-dot'
    else if (value === '?') cls += ' cluedo-cell-Q1'
    else if (value === '??') cls += ' cluedo-cell-Q2'
    else if (value === '???') cls += ' cluedo-cell-Q3'
    else if (/^[1-9]$/.test(value)) cls += ` cluedo-cell-num-${value}`
    return cls
  }

  const renderBlock = (title, blockId, rows) => (
    <div className="cluedo-block">
      <h2 className="cluedo-block-title">{title}</h2>
      <div
        className="cluedo-table"
        style={{ '--players': playersCount }}
      >
        <div className="cluedo-header-row">
          <div className="cluedo-cell cluedo-cell-header cluedo-cell-first">Игрок</div>

          <div className="cluedo-cell cluedo-cell-header cluedo-cell-player">
            <span className="cluedo-player-static">Я</span>
          </div>

          {otherPlayers.map((name, i) => (
            <div key={i} className="cluedo-cell cluedo-cell-header cluedo-cell-player">
              <input
                type="text"
                className="cluedo-name-input"
                value={name}
                onChange={(e) => handleNameChange(i, e.target.value)}
                placeholder={`Игр.${i + 2}`}
              />
            </div>
          ))}
        </div>

        {rows.map((row) => {
          const rowKey = `${blockId}-${row}`
          const rowState = crossedRows[rowKey] || 'default'
          return (
            <div
              key={row}
              className={`cluedo-row ${rowState === 'crossed' ? 'cluedo-row-crossed' : ''
                } ${rowState === 'outlined' ? 'cluedo-row-outlined' : ''
                }`}
            >
              <button
                type="button"
                className="cluedo-cell cluedo-cell-first cluedo-row-title"
                onClick={() => handleRowClick(blockId, row)}
              >
                {row}
              </button>

              {/* Ячейка "Я" */}
              <button
                type="button"
                className={getCellClass(cells[`${blockId}-${row}-0`] || '')}
                onClick={(e) => handleCellClick(e, blockId, row, 0)}
              >
                {cells[`${blockId}-${row}-0`] || ''}
              </button>

              {/* Ячейки других игроков */}
              {otherPlayers.map((_, i) => {
                const idx = i + 1
                const cellKey = `${blockId}-${row}-${idx}`
                const value = cells[cellKey] || ''
                return (
                  <button
                    type="button"
                    key={idx}
                    className={getCellClass(value)}
                    onClick={(e) => handleCellClick(e, blockId, row, idx)}
                  >
                    {value}
                  </button>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )

  return (
    <div className='cluedo-app'>
      <div className="cluedo-panel">
        <div className="cluedo-panel-actions">
          <Link to="/">
            <div className="hab-logo">H</div>
          </Link>
          <button
            type="button"
            className="theme-toggle"
            onClick={toggleTheme}
            title="Сменить тему"
          >
            {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
          </button>

          <button type="button" className="cluedo-newgame" onClick={handleNewGame}>
            <RotateCcw size={18} />
            <span>Новая игра</span>
          </button>
        </div>
        <div className="cluedo-panel-block">
          <div className="cluedo-panel-label">
            <Users size={18} />
            <span>Игроки: {playersCount}</span>
          </div>
          <input
            type="range"
            min="2"
            max="6"
            value={playersCount}
            onChange={(e) => handlePlayersCountChange(Number(e.target.value))}
            className="cluedo-slider"
          />
        </div>
      </div>

      <div className="cluedo-body">
        {renderBlock('Кто?', 'who', SUSPECTS)}
        {renderBlock('Чем?', 'weapon', WEAPONS)}
        {renderBlock('Где?', 'room', ROOMS)}
      </div>

      {popup && (
        <div
          className="cluedo-popup"
          ref={popupRef}
          style={{
            left: `${Math.min(Math.max(popup.x, 100), window.innerWidth - 100)}px`,
            top: `${popup.y}px`,
          }}
        >
          {STATUSES.map((status) => (
            <button
              key={status || 'empty'}
              type="button"
              className={`cluedo-popup-item ${popup.currentValue === status ? 'active' : ''
                } ${status === '✓' ? 'popup-yes' : ''
                } ${status === '✕' ? 'popup-no' : ''
                } ${status === '•' ? 'popup-dot' : ''
                } ${status === '?' ? 'popup-Q1' : ''
                } ${status === '??' ? 'popup-Q2' : ''
                } ${status === '???' ? 'popup-Q3' : ''
                } ${/^[1-9]$/.test(status) ? `popup-num-${status}` : ''
                }`}
              onClick={() => handleSelectValue(status)}
            >
              {status || '—'}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}