import { Link } from 'react-router-dom'

export default function ElysiumFooter() {
  return (
    <footer className="footer">
      <div className="footer-top">

        <div className='footer-links-main'>
          <div className="footer-links">
            <p className="footer-heading">Навигация</p>
            <Link to="/elysium" className="footer-link">Главная</Link>
            <Link to="/elysium/friends" className="footer-link">Друзья</Link>
            <Link to="/elysium/match" className="footer-link">Подбор</Link>
          </div>
          <div className="footer-links">
            <p className="footer-heading">Аккаунт</p>
            <Link to="/elysium/login" className="footer-link">Войти</Link>
            <Link to="/elysium/register" className="footer-link">Регистрация</Link>
          </div>
        </div>

        <div>
          <p className="footer-logo">Elysium</p>
          <p className="footer-txt">
            Сервис для подбора фильмов и сериалов с друзьями
          </p>
        </div>
      </div>

      <div className="footer-bottom">
        <p>© {new Date().getFullYear()} Elysium. Все права защищены.</p>
        <p>Создатель: Elisey Koren</p>
      </div>
    </footer>
  )
}