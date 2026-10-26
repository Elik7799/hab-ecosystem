import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    // Это заставляет Vite отдавать index.html для любых путей, 
    // чтобы React Router мог сам разобраться, куда вести пользователя
    historyApiFallback: true, 
  },
})