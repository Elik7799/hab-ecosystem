import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/ElysiumAuthContext'
import { showSuccess, showError } from '../../../utils/ElysiumToast'

export default function ElysiumLogin() {
  const navigate = useNavigate()
  const { login } = useAuth()

  const [formData, setFormData] = useState({
    email: '',
    password: '',
  })

  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleChange = (e) => {
    const { name, value } = e.target
    setFormData((prev) => ({ ...prev, [name]: value }))
    setError('')
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError('')

    try {
      const res = await fetch('https://hab-ecosystem.onrender.com/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      })

      const data = await res.json()

      if (!res.ok) {
        setError(data.error || 'Ошибка входа')
        showError(data.error || 'Ошибка входа')
        return
      }

      login(data.token, data.user)
      showSuccess('Добро пожаловать!')
      navigate('/elysium')
    } catch (err) {
      setError('Не удалось подключиться к серверу')
      showError('Не удалось подключиться к серверу')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-body">
      <form className="login-container" onSubmit={handleSubmit}>
        <h1 className="login-title">Вход</h1>

        <div className="login-field">
          <label htmlFor="email" className="login-txt">
            Адрес электронной почты
          </label>
          <input
            id="email"
            name="email"
            type="email"
            placeholder="ivan@example.com"
            className="login-input"
            value={formData.email}
            onChange={handleChange}
          />
        </div>

        <div className="login-field">
          <label htmlFor="password" className="login-txt">
            Пароль
          </label>
          <input
            id="password"
            name="password"
            type="password"
            placeholder="••••••••"
            className="login-input"
            value={formData.password}
            onChange={handleChange}
          />
        </div>

        {error && <p className="login-error">{error}</p>}

        <button type="submit" className="login-button" disabled={loading}>
          {loading ? 'Вход...' : 'Войти'}
        </button>

        <p className="login-link">
          Нет аккаунта? <Link to="/elysium/register">Зарегистрироваться</Link>
        </p>
      </form>
    </div>
  )
}