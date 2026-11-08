import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'

const APP_CONFIG = {
  '/elysium': { title: 'Elysium', icon: '/icons/elysium-icon.png' },
  '/':        { title: 'Hub',     icon: '/icons/hub-icon.png' },
  '/cluedo':  { title: 'Cluedo',     icon: '/icons/cluedo-icon.png' },
  '/buckshot':{ title: 'Buckshot',     icon: '/icons/buckshot-icon.png' },
}

export default function DynamicAppIcon() {
  const { pathname } = useLocation()

  useEffect(() => {
    const key = Object.keys(APP_CONFIG).find(k =>
      k === '/' ? pathname === '/' : (pathname === k || pathname.startsWith(k + '/'))
    )
    const config = APP_CONFIG[key] || APP_CONFIG['/']

    document.title = config.title

    const old = document.querySelector('link[rel="apple-touch-icon"]')
    if (old) old.remove()

    const link = document.createElement('link')
    link.rel = 'apple-touch-icon'
    link.href = config.icon
    document.head.appendChild(link)
  }, [pathname])

  return null
}