import { Link } from 'react-router-dom'

export default function ElysiumFooter() {
  return (
    <footer className="footer">
      <div className="footer-top">
        <div className='footer-top-block1'>
          <p className="footer-logo">Elysium</p>
          <p className="footer-txt">
            Сервис для подбора фильмов и сериалов с друзьями
          </p>
        </div>
        <div className='footer-top-block2'>
          <Link to="/elysium/import" className="footer-logo">Импорт</Link>
        </div>
      </div>

      <div className="footer-bottom">
        <p>© {new Date().getFullYear()} Elysium. Все права защищены.</p>
        <p>Создатель: Elisey Koren</p>
      </div>
    </footer>
  )
}