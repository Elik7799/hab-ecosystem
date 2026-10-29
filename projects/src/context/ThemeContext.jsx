import { createContext, useContext, useState, useEffect } from 'react'

const ThemeContext = createContext()

export function ThemeProvider({ children }) {
  // По умолчанию берем тему из localStorage или ставим 'dark'
  const [theme, setTheme] = useState(() => {
    return localStorage.getItem('hab-theme') || 'dark'
  })

  useEffect(() => {
    // Применяем класс к тегу <html> (или <body>)
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('hab-theme', theme)
  }, [theme])

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))
  }

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  return useContext(ThemeContext)
}