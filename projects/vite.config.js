import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  define: {
    // Жестко задаем адрес API для продакшена
    'import.meta.env.VITE_API_URL': JSON.stringify(process.env.VITE_API_URL || 'https://hab-ecosystem.onrender.com/api')
  }
})