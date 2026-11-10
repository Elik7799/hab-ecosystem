import { useEffect, useLayoutEffect, useRef } from 'react'

// Отключаем встроенное браузерное восстановление скролла — у нас своё.
if (typeof window !== 'undefined' && 'scrollRestoration' in window.history) {
    window.history.scrollRestoration = 'manual'
}

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
 *
 * @param {string|null} key - ключ в sessionStorage (null — не активировать)
 * @param {boolean} ready - восстанавливать только когда данные загружены
 */
export function useScrollRestore(key, ready = true) {
    const restoredFor = useRef(null)

    // Сохраняем на каждом scroll + на unmount
    useEffect(() => {
        if (!key) return
        const handler = () => sessionStorage.setItem(key, String(getScrollY()))
        window.addEventListener('scroll', handler, { passive: true, capture: true })
        return () => {
            window.removeEventListener('scroll', handler, { capture: true })
            sessionStorage.setItem(key, String(getScrollY()))
        }
    }, [key])

    // Восстанавливаем. ResizeObserver ждёт, пока контент дорастёт до нужной высоты.
    useLayoutEffect(() => {
        if (!key || !ready) return
        if (restoredFor.current === key) return
        restoredFor.current = key

        const raw = sessionStorage.getItem(key)
        if (!raw) return
        const y = Number(raw)
        if (!y || y <= 0) return

        let cancelled = false
        let ro = null
        let timeout = null

        const tryScroll = () => {
            if (cancelled) return
            setScrollY(y)
        }

        // Первая попытка сразу
        tryScroll()

        // Следим за высотой документа — восстанавливаем, как только сможем
        const startObserver = () => {
            if (cancelled) return
            const targets = [document.body]
            const main = document.querySelector('.app-main')
            if (main) targets.push(main)
            const wrapper = document.querySelector('.app-wrapper')
            if (wrapper) targets.push(wrapper)

            try {
                ro = new ResizeObserver(() => {
                    if (cancelled) return
                    if (getScrollY() >= y - 2) {
                        // Доехали — отключаемся
                        ro?.disconnect()
                        if (timeout) { clearTimeout(timeout); timeout = null }
                        return
                    }
                    tryScroll()
                })
                targets.forEach(t => t && ro.observe(t))
            } catch {
                // Fallback на ретраи, если ResizeObserver не поддерживается
                let attempts = 0
                const retry = () => {
                    if (cancelled) return
                    setScrollY(y)
                    if (getScrollY() < y - 2 && attempts < 60) {
                        attempts++
                        setTimeout(retry, 50)
                    }
                }
                retry()
            }
        }

        // Даём React смонтировать DOM на один тик, потом ставим observer
        const t = setTimeout(startObserver, 0)

        // Страховочный таймаут — через 10 сек прекращаем наблюдение
        timeout = setTimeout(() => {
            if (ro) ro.disconnect()
        }, 10000)

        return () => {
            cancelled = true
            clearTimeout(t)
            if (timeout) clearTimeout(timeout)
            if (ro) ro.disconnect()
        }
    }, [key, ready])
}