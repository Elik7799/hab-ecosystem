import { useEffect, useLayoutEffect, useRef } from 'react'

// Пробуем все возможные scroll-контейнеры. Возвращает максимум — тот,
// который реально прокручен.
export function getScrollY() {
    const candidates = [0]
    candidates.push(window.scrollY || 0)
    candidates.push(window.pageYOffset || 0)
    candidates.push(document.documentElement?.scrollTop || 0)
    candidates.push(document.body?.scrollTop || 0)
    const main = document.querySelector('.app-main')
    if (main) candidates.push(main.scrollTop || 0)
    const wrapper = document.querySelector('.app-wrapper')
    if (wrapper) candidates.push(wrapper.scrollTop || 0)
    return Math.max(...candidates)
}

// Прокручиваем ВСЕ возможные контейнеры. Для того, который реально скроллится —
// значение применится, для остальных — no-op.
export function setScrollY(y) {
    window.scrollTo(0, y)
    if (document.documentElement) document.documentElement.scrollTop = y
    if (document.body) document.body.scrollTop = y
    const main = document.querySelector('.app-main')
    if (main) main.scrollTop = y
    const wrapper = document.querySelector('.app-wrapper')
    if (wrapper) wrapper.scrollTop = y
}

export function scrollToTop() {
    setScrollY(0)
}

/**
 * Хук сохранения/восстановления скролла.
 * @param {string} key - ключ в sessionStorage
 * @param {boolean} ready - восстанавливать только когда данные загружены
 */
export function useScrollRestore(key, ready = true) {
    const restoredFor = useRef(null)

    // Сохраняем на каждом движении + на unmount (страховка)
    useEffect(() => {
        if (!key) return
        const handler = () => sessionStorage.setItem(key, String(getScrollY()))
        window.addEventListener('scroll', handler, { passive: true, capture: true })
        return () => {
            window.removeEventListener('scroll', handler, { capture: true })
            sessionStorage.setItem(key, String(getScrollY()))
        }
    }, [key])

    // Восстанавливаем с ретраями, пока контент не дорастёт до сохранённой высоты
    useLayoutEffect(() => {
        if (!key || !ready) return
        if (restoredFor.current === key) return
        restoredFor.current = key

        const raw = sessionStorage.getItem(key)
        if (!raw) return
        const y = Number(raw)
        if (!y || y <= 0) return

        let cancelled = false
        let attempts = 0
        const maxAttempts = 40 // 40 × 40 мс ≈ 1.6 сек — хватит на догрузку картинок
        const tryRestore = () => {
            if (cancelled) return
            setScrollY(y)
            if (getScrollY() < y - 2 && attempts < maxAttempts) {
                attempts++
                setTimeout(tryRestore, 40)
            }
        }
        tryRestore()

        return () => { cancelled = true }
    }, [key, ready])
}