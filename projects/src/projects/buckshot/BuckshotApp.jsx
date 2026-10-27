import { useState } from 'react'
import { Target, Settings2 } from 'lucide-react'
import './buckshot.css'

export default function BuckshotApp() {
    const [isSetup, setIsSetup] = useState(true)
    const [liveCount, setLiveCount] = useState(2)
    const [blankCount, setBlankCount] = useState(2)

    const [shells, setShells] = useState([])
    const [currentIndex, setCurrentIndex] = useState(0)

    const startGame = () => {
        const total = liveCount + blankCount
        setShells(Array(total).fill('unknown'))
        setCurrentIndex(0)
        setIsSetup(false)
    }

    const resetGame = () => {
        setIsSetup(true)
        setShells([])
        setCurrentIndex(0)
    }

    const toggleShellState = (index) => {
        // Нельзя менять уже выстрелившие патроны
        if (index < currentIndex) return

        const currentState = shells[index]
        let nextState = 'unknown'

        // Считаем, сколько текущих меток
        const currentLiveMarks = shells.filter(s => s === 'live').length
        const currentBlankMarks = shells.filter(s => s === 'blank').length

        // Правило 1: Если патрон неизвестен
        if (currentState === 'unknown') {
            if (currentLiveMarks < liveCount) {
                nextState = 'live' // Есть места под боевые — ставим боевой
            } else if (currentBlankMarks < blankCount) {
                nextState = 'blank' // Боевых нет, но есть холостые — ставим холостой
            } else {
                return // Лимиты исчерпаны
            }
        }
        // Правило 2: Если патрон боевой
        else if (currentState === 'live') {
            if (currentBlankMarks < blankCount) {
                nextState = 'blank' // Есть места под холостые — ставим холостой
            } else {
                nextState = 'unknown' // Холостых нет — сбрасываем в неизвестное
            }
        }
        // Правило 3: Если патрон холостой
        else if (currentState === 'blank') {
            nextState = 'unknown' // Всегда сбрасываем в неизвестное
        }

        setShells((prev) => {
            const next = [...prev]
            next[index] = nextState
            return next
        })
    }

    const shoot = () => {
        const currentShell = shells[currentIndex]
        if (!currentShell || currentShell === 'unknown') return

        if (currentShell === 'live') setLiveCount(prev => prev - 1)
        if (currentShell === 'blank') setBlankCount(prev => prev - 1)

        setCurrentIndex((prev) => prev + 1)
    }

    const getProbabilities = () => {
        const remainingSlots = shells.length - currentIndex
        if (remainingSlots <= 0) return { live: 0, blank: 0 }

        const currentShell = shells[currentIndex]

        if (currentShell === 'live') return { live: 100, blank: 0 }
        if (currentShell === 'blank') return { live: 0, blank: 100 }

        const knownLiveLeft = shells.slice(currentIndex).filter(s => s === 'live').length
        const knownBlankLeft = shells.slice(currentIndex).filter(s => s === 'blank').length

        const liveLeft = Math.max(0, liveCount - knownLiveLeft)
        const blankLeft = Math.max(0, blankCount - knownBlankLeft)

        const totalUnknownPool = liveLeft + blankLeft

        if (totalUnknownPool === 0) return { live: 0, blank: 0 }

        return {
            live: Math.round((liveLeft / totalUnknownPool) * 100),
            blank: Math.round((blankLeft / totalUnknownPool) * 100)
        }
    }

    const probs = getProbabilities()

    const isCurrentShellUnknown = shells[currentIndex] === 'unknown' || !shells[currentIndex]
    const isGameOver = currentIndex >= shells.length

    // Проверяем лимиты для тултипов
    const currentLiveMarks = shells.filter(s => s === 'live').length
    const currentBlankMarks = shells.filter(s => s === 'blank').length
    const canMarkLive = currentLiveMarks < liveCount
    const canMarkBlank = currentBlankMarks < blankCount

    if (isSetup) {
        return (
            <div className="buckshot-app">
                <header className="buckshot-header">
                    <h1>Buckshot Helper</h1>
                    <p>Настройка раунда</p>
                </header>

                <div className="buckshot-setup">
                    <div className="setup-group">
                        <label className="setup-label live-label">Боевые (Красные)</label>
                        <div className="setup-controls">
                            <button onClick={() => setLiveCount(Math.max(0, liveCount - 1))}>-</button>
                            <span className="setup-value">{liveCount}</span>
                            <button onClick={() => setLiveCount(Math.min(8, liveCount + 1))}>+</button>
                        </div>
                    </div>

                    <div className="setup-group">
                        <label className="setup-label blank-label">Холостые (Синие)</label>
                        <div className="setup-controls">
                            <button onClick={() => setBlankCount(Math.max(0, blankCount - 1))}>-</button>
                            <span className="setup-value">{blankCount}</span>
                            <button onClick={() => setBlankCount(Math.min(8, blankCount + 1))}>+</button>
                        </div>
                    </div>

                    <button
                        className="buckshot-start-btn"
                        onClick={startGame}
                        disabled={liveCount + blankCount === 0 || liveCount + blankCount > 8}
                    >
                        Начать ({liveCount + blankCount} патронов)
                    </button>
                </div>
            </div>
        )
    }

    return (
        <div className="buckshot-app">
            <header className="buckshot-header">
                <h1>Buckshot Helper</h1>
                <p>В стволе осталось: {shells.length - currentIndex} патронов</p>
            </header>

            <main className="buckshot-main">
                <div className="buckshot-stats">
                    <div className="stat-box live-stat">
                        <span className="stat-title">Боевых осталось</span>
                        <span className="stat-value">{liveCount}</span>
                    </div>
                    <div className="stat-box blank-stat">
                        <span className="stat-title">Холостых осталось</span>
                        <span className="stat-value">{blankCount}</span>
                    </div>
                </div>

                <div className="buckshot-probs">
                    <div className={`prob-bar live-bar ${probs.live === 100 ? 'full' : ''}`} style={{ width: `${probs.live}%` }}>
                        {probs.live > 10 && `${probs.live}%`}
                    </div>
                    <div className={`prob-bar blank-bar ${probs.blank === 100 ? 'full' : ''}`} style={{ width: `${probs.blank}%` }}>
                        {probs.blank > 10 && `${probs.blank}%`}
                    </div>
                </div>
                <div className="buckshot-prob-labels">
                    <span>Шанс Боевого: {probs.live}%</span>
                    <span>Шанс Холостого: {probs.blank}%</span>
                </div>

                <div className="buckshot-track">
                    {shells.map((state, index) => {
                        const isFired = index < currentIndex
                        const isCurrent = index === currentIndex

                        return (
                            <div
                                key={index}
                                className={`buckshot-shell ${state} ${isFired ? 'fired' : ''} ${isCurrent ? 'current' : ''}`}
                                onClick={() => toggleShellState(index)}
                            >
                                <div className="buckshot-shell-inner">
                                    {state === 'live' && <span className="buckshot-icon">💥</span>}
                                    {state === 'blank' && <span className="buckshot-icon">💨</span>}
                                    {state === 'unknown' && <span className="buckshot-icon">?</span>}
                                </div>
                                <span className="buckshot-index">{index + 1}</span>
                            </div>
                        )
                    })}
                </div>

                <div className="buckshot-actions">
                    <button
                        className="buckshot-action-btn shoot"
                        onClick={shoot}
                        disabled={isCurrentShellUnknown || isGameOver}
                    >
                        <Target size={18} />
                        {isCurrentShellUnknown ? 'Выстрел (выберите патрон)' : 'Выстрел'}
                    </button>

                    <button className="buckshot-action-btn reset" onClick={resetGame}>
                        <Settings2 size={18} />
                        Новый раунд
                    </button>
                </div>

                {isGameOver && <div className="buckshot-gameover">Ствол пуст!</div>}
            </main>
        </div>
    )
}