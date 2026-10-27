import { Routes, Route, Navigate } from 'react-router-dom'
import Hab from './pages/Hab'
import ElysiumApp from './projects/elysium/ElysiumApp'
import CluedoApp from './projects/cluedo/CluedoApp'
import BuckshotApp from './projects/buckshot/BuckshotApp'

function App() {
  return (
    <Routes>
      <Route path="/" element={<Hab />} />
      <Route path="/elysium/*" element={<ElysiumApp />} />
      <Route path="/cluedo/*" element={<CluedoApp />} />
      <Route path="/buckshot/*" element={<BuckshotApp />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App