import { createContext, useContext, useState, useEffect } from 'react'

const AuthContext = createContext()

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [token, setToken] = useState(null)
  const [loading, setLoading] = useState(true)

  // При загрузке проверяем, есть ли токен в localStorage
  useEffect(() => {
    const savedToken = localStorage.getItem('token')
    const savedUser = localStorage.getItem('user')

    if (savedToken && savedUser) {
      try {
        // 1. Достаем payload из JWT (вторая часть токена между точками)
        // JWT имеет формат: header.payload.signature
        const payloadBase64 = savedToken.split('.')[1]
        
        // 2. Декодируем base64 (используем atob, который работает в браузере)
        // Добавляем padding, если его нет (atob требует длину, кратную 4)
        const decodedPayload = JSON.parse(atob(payloadBase64))

        // 3. Проверяем срок действия (exp хранится в секундах)
        const isExpired = decodedPayload.exp * 1000 < Date.now()

        if (isExpired) {
          // Токен просрочен — очищаем
          localStorage.removeItem('token')
          localStorage.removeItem('user')
          setToken(null)
          setUser(null)
        } else {
          // Токен валиден
          setToken(savedToken)
          setUser(JSON.parse(savedUser))
        }
      } catch (error) {
        // Если токен битый или не JSON — очищаем
        console.error('Ошибка проверки токена:', error)
        localStorage.removeItem('token')
        localStorage.removeItem('user')
        setToken(null)
        setUser(null)
      }
    }
    setLoading(false)
  }, [])

  const login = (newToken, newUser) => {
    setToken(newToken)
    setUser(newUser)
    localStorage.setItem('token', newToken)
    localStorage.setItem('user', JSON.stringify(newUser))
  }

  const logout = () => {
    setToken(null)
    setUser(null)
    localStorage.removeItem('token')
    localStorage.removeItem('user')
  }

  return (
    <AuthContext.Provider value={{ user, token, login, logout, loading }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}