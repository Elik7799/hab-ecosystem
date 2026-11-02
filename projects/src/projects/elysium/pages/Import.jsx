import { useState, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/ElysiumAuthContext'
import { showSuccess, showError } from '../../../utils/ElysiumToast'
import { Upload, FileSpreadsheet, CheckCircle } from 'lucide-react'

const API_URL_BACKEND = 'https://hab-ecosystem.onrender.com/api'

export default function ElysiumImport() {
  const { token } = useAuth()
  const [file, setFile] = useState(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isSuccess, setIsSuccess] = useState(false)
  const fileInputRef = useRef(null)

  const handleFileChange = (e) => {
    const selected = e.target.files[0]
    if (!selected) return

    // Проверка расширения
    const ext = selected.name.split('.').pop().toLowerCase()
    if (ext !== 'xlsx') {
      showError('Пожалуйста, выберите файл в формате .xlsx')
      setFile(null)
      return
    }

    setFile(selected)
    setIsSuccess(false)
  }

  const handleSubmit = async () => {
    if (!file) return

    setIsLoading(true)
    const formData = new FormData()
    formData.append('file', file)

    try {
      const res = await fetch(`${API_URL_BACKEND}/import/upload`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: formData,
      })

      if (res.ok) {
        setIsSuccess(true)
        showSuccess('Файл отправлен!')
      } else {
        const data = await res.json()
        showError(data.error || 'Ошибка отправки')
      }
    } catch (err) {
      console.error(err)
      showError('Ошибка сети')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="import-body">
      <h1 className="import-title">Импорт фильмов</h1>

      <div className="import-instruction">
        <h2>Инструкция</h2>
        <p>Для импорта ваших фильмов подготовьте файл в формате <strong>.xlsx</strong></p>
        <ul>
          <li>Во втором столбце должно быть <strong>название (original_name / ru_name)</strong></li>
          <li>В третьем столбце — <strong>год (year)</strong> выхода (необязателен, но с ним будет корректно)</li>
          <li>В пятом столбце — <strong>статус</strong></li>
          <li>Для фильмов: <strong>"Посмотрел"</strong> или <strong>"Буду смотреть"</strong></li>
          <li>Для сериалов: <strong>"Смотрю"</strong>, <strong>"Посмотрел"</strong> или <strong>"Буду смотреть"</strong></li>
        </ul>
        <p>Файлы других форматов не принимаются.</p>
      </div>

      {isSuccess ? (
        <div className="import-success">
          <CheckCircle size={48} color="#22c55e" />
          <h2>Файл отправлен!</h2>
          <p>Изменения будут проведены в ближайшее время.</p>
          <Link to="/elysium" className="import-btn">Вернуться на главную</Link>
        </div>
      ) : (
        <div className="import-upload-area">
          <input
            type="file"
            accept=".xlsx"
            ref={fileInputRef}
            onChange={handleFileChange}
            style={{ display: 'none' }}
          />
          
          <div 
            className="import-dropzone" 
            onClick={() => fileInputRef.current?.click()}
          >
            <FileSpreadsheet size={48} color="#c70000" />
            <p>Нажмите, чтобы выбрать файл</p>
            <span>Только формат .xlsx</span>
          </div>

          {file && (
            <div className="import-file-info">
              <span>Выбран файл: <strong>{file.name}</strong></span>
            </div>
          )}

          <button 
            className="import-submit-btn"
            onClick={handleSubmit}
            disabled={!file || isLoading}
          >
            <Upload size={18} />
            {isLoading ? 'Отправка...' : 'Отправить файл'}
          </button>
        </div>
      )}
    </div>
  )
}