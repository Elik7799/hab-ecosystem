import { useState, useEffect, useRef } from 'react'
import { Link, NavLink, useNavigate, useLocation } from 'react-router-dom'
import { House, Users, Sparkles, User, LogOut, Menu, X } from 'lucide-react'
import { useAuth } from '../context/ElysiumAuthContext'
import ElysiumNotificationsBell from './ElysiumNotificationsBell'

export default function ElysiumHeader() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef(null)

  useEffect(() => {
    setMenuOpen(false)
  }, [location.pathname])

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleLogout = () => {
    setMenuOpen(false)
    logout()
    navigate('/elysium/login')
  }

  return (
    <nav className="header-navbar" ref={menuRef}>
      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <Link to="/">
          <div className="elysium-hab-logo">H</div>
        </Link>
        <Link to="/elysium" className="header-logo">
          <span className="header-logotxt">Elysium</span>
        </Link>
      </div>

      <div className="header-div header-div-desktop">
        <NavLink
          to="/elysium"
          end
          className={({ isActive }) =>
            isActive ? 'header-button active' : 'header-button'
          }
        >
          <House />
        </NavLink>

        {user && (
          <>
            <NavLink
              to="/elysium/friends"
              className={({ isActive }) =>
                isActive ? 'header-button active' : 'header-button'
              }
            >
              <Users />
            </NavLink>

            <NavLink
              to="/elysium/match"
              className={({ isActive }) =>
                isActive ? 'header-button active' : 'header-button'
              }
            >
              <Sparkles />
            </NavLink>

            <ElysiumNotificationsBell />
          </>
        )}

        {user ? (
          <>
            <Link to="/elysium/profile" className="header-user">
              <User size={18} />
              <span>@{user.name}</span>
            </Link>
            <button
              type="button"
              className="header-button"
              onClick={handleLogout}
              title="Выйти"
            >
              <LogOut />
            </button>
          </>
        ) : (
          <NavLink
            to="/elysium/login"
            className={({ isActive }) =>
              isActive ? 'header-buttonlogin active' : 'header-buttonlogin'
            }
          >
            Войти
          </NavLink>
        )}
      </div>

      <div className="header-div-mobile">
        {user && <ElysiumNotificationsBell />}

        <button
          type="button"
          className="header-burger"
          onClick={() => setMenuOpen((prev) => !prev)}
          aria-label="Меню"
        >
          {menuOpen ? <X /> : <Menu />}
        </button>
      </div>

      {menuOpen && (
        <div className="header-mobile-dropdown">
          <NavLink
            to="/elysium"
            end
            className={({ isActive }) =>
              isActive
                ? 'header-mobile-item header-mobile-item-active'
                : 'header-mobile-item'
            }
            onClick={() => setMenuOpen(false)}
          >
            <House size={20} />
            <span>Главная</span>
          </NavLink>

          {user && (
            <>
              <NavLink
                to="/elysium/friends"
                className={({ isActive }) =>
                  isActive
                    ? 'header-mobile-item header-mobile-item-active'
                    : 'header-mobile-item'
                }
                onClick={() => setMenuOpen(false)}
              >
                <Users size={20} />
                <span>Друзья</span>
              </NavLink>

              <NavLink
                to="/elysium/match"
                className={({ isActive }) =>
                  isActive
                    ? 'header-mobile-item header-mobile-item-active'
                    : 'header-mobile-item'
                }
                onClick={() => setMenuOpen(false)}
              >
                <Sparkles size={20} />
                <span>Подбор</span>
              </NavLink>

              <NavLink
                to="/elysium/profile"
                className={({ isActive }) =>
                  isActive
                    ? 'header-mobile-item header-mobile-item-active'
                    : 'header-mobile-item'
                }
                onClick={() => setMenuOpen(false)}
              >
                <User size={20} />
                <span>@{user.name}</span>
              </NavLink>

              <button
                type="button"
                className="header-mobile-item header-mobile-item-logout"
                onClick={handleLogout}
              >
                <LogOut size={20} />
                <span>Выйти</span>
              </button>
            </>
          )}

          {!user && (
            <NavLink
              to="/elysium/login"
              className={({ isActive }) =>
                isActive
                  ? 'header-mobile-item header-mobile-item-active'
                  : 'header-mobile-item'
              }
              onClick={() => setMenuOpen(false)}
            >
              <User size={20} />
              <span>Войти</span>
            </NavLink>
          )}
        </div>
      )}
    </nav>
  )
}