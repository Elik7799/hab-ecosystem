import { useNavigate } from 'react-router-dom'
import './hab.css'
import { useTheme } from '../context/ThemeContext'
import { Sun, Moon } from 'lucide-react'

const projects = [
  {
    id: 'elysium',
    title: 'Elysium',
    description: 'Кино-сообщество: подбор фильмов, друзья, матчинг по вкусам.',
    icon: '🎬',
    path: '/elysium',
    disabled: false,
  },

  {
    id: 'cluedo',
    title: 'Cluedo',
    description: 'Интерактивная таблица для настольной игры. Ищите убийцу вместе.',
    icon: '🕵️',
    path: '/cluedo',
    disabled: false,
  },

  {
    id: 'buckshot',
    title: 'Buckshot Roulette',
    description: 'Помощник для подсчета патронов. Следи за холостыми и боевыми.',
    icon: '🔫',
    path: '/buckshot',
    disabled: false,
  },

  {
    id: 'soon',
    title: 'Скоро',
    description: 'Новые проекты появятся здесь в ближайшее время.',
    icon: '✨',
    path: null,
    disabled: true,
  },
]

function Hab() {
  const navigate = useNavigate()
  const { theme, toggleTheme } = useTheme()

  return (
    <div className="hab">
      <div className="hab-header">
        <div className="hab-brand">
          <div className="hab-logo">H</div>
          <h1>HAB</h1>
        </div>
        <p className="hab-subtitle">Экосистема ваших проектов</p>
        <button
          type="button"
          className="theme-toggle"
          onClick={toggleTheme}
          title="Сменить тему"
        >
          {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
        </button>
      </div>

      <main className="hab-grid">
        {projects.map((project) => (
          <div
            key={project.id}
            className={`hab-card ${project.disabled ? 'hab-card--disabled' : ''}`}
            onClick={() => {
              if (!project.disabled && project.path) {
                navigate(project.path)
              }
            }}
          >
            <div className="hab-card__icon">{project.icon}</div>
            <div className="hab-card__content">
              <h2>{project.title}</h2>
              <p>{project.description}</p>
            </div>
            {!project.disabled && <div className="hab-card__arrow">→</div>}
          </div>
        ))}
      </main>

      <footer className="hab-footer">
        <span>© {new Date().getFullYear()} HAB. Все права защищены.</span>
      </footer>
    </div>
  )
}

export default Hab