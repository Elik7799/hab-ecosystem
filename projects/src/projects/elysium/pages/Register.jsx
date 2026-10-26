import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { showSuccess, showError } from '../../../utils/ElysiumToast'

export default function ElysiumRegister() {
  const navigate = useNavigate()

  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    confirmPassword: '',
  })

  const [errors, setErrors] = useState({})
  const [serverError, setServerError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleChange = (e) => {
    const { name, value } = e.target
    setFormData((prev) => ({ ...prev, [name]: value }))
    setErrors((prev) => ({ ...prev, [name]: '' }))
    setServerError('')
  }

  const validate = () => {
    const newErrors = {}

    if (!formData.name.trim()) {
      newErrors.name = 'Введите ник'
    } else if (formData.name.length < 3) {
      newErrors.name = 'Ник должен быть минимум 3 символа'
    } else if (!/^[a-zA-Z0-9_]+$/.test(formData.name)) {
      newErrors.name = 'Только латиница, цифры и _'
    }

    if (!formData.email.trim()) {
      newErrors.email = 'Введите email'
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      newErrors.email = 'Некорректный email'
    }

    if (!formData.password) {
      newErrors.password = 'Введите пароль'
    } else if (formData.password.length < 6) {
      newErrors.password = 'Пароль должен быть минимум 6 символов'
    }

    if (formData.password !== formData.confirmPassword) {
      newErrors.confirmPassword = 'Пароли не совпадают'
    }

    return newErrors
  }

  const handleSubmit = async (e) => {
    e.preventDefault()

    const newErrors = validate()
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors)
      return
    }

    setLoading(true)
    setServerError('')

    try {
      const res = await fetch('https://hab-ecosystem.onrender.com/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formData.name,
          email: formData.email,
          password: formData.password,
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        setServerError(data.error || 'Ошибка регистрации')
        showError(data.error || 'Ошибка регистрации')
        return
      }

      showSuccess('Аккаунт создан! Войдите.')
      navigate('/elysium/login')
    } catch (err) {
      setServerError('Не удалось подключиться к серверу')
      showError('Не удалось подключиться к серверу')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-body">
      <form className="login-container" onSubmit={handleSubmit}>
        <h1 className="login-title">Регистрация</h1>

        <div className="login-field">
          <label htmlFor="name" className="login-txt">
            Ник
          </label>
          <input
            id="name"
            name="name"
            type="text"
            placeholder="elik"
            className="login-input"
            value={formData.name}
            onChange={handleChange}
          />
          {errors.name && <span className="login-error">{errors.name}</span>}
        </div>

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
          {errors.email && <span className="login-error">{errors.email}</span>}
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
          {errors.password && (
            <span className="login-error">{errors.password}</span>
          )}
        </div>

        <div className="login-field">
          <label htmlFor="confirmPassword" className="login-txt">
            Повторите пароль
          </label>
          <input
            id="confirmPassword"
            name="confirmPassword"
            type="password"
            placeholder="••••••••"
            className="login-input"
            value={formData.confirmPassword}
            onChange={handleChange}
          />
          {errors.confirmPassword && (
            <span className="login-error">{errors.confirmPassword}</span>
          )}
        </div>

        {serverError && <p className="login-error">{serverError}</p>}

        <button type="submit" className="login-button" disabled={loading}>
          {loading ? 'Регистрация...' : 'Зарегистрироваться'}
        </button>

        <p className="login-link">
          Уже есть аккаунт? <Link to="/elysium/login">Войти</Link>
        </p>
      </form>
    </div>
  )
}