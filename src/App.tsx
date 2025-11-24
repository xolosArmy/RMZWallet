import { Navigate, Route, Routes } from 'react-router-dom'
import Dashboard from './routes/Dashboard'
import SendRMZ from './routes/SendRMZ'
import Receive from './routes/Receive'
import Settings from './routes/Settings'
import Onboarding from './routes/Onboarding'
import BackupSeed from './routes/BackupSeed'

function App() {
  return (
    <div className="app-shell">
      <div className="app-glow" aria-hidden />
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/send" element={<SendRMZ />} />
        <Route path="/receive" element={<Receive />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/backup" element={<BackupSeed />} />
        <Route path="*" element={<Navigate to="/onboarding" replace />} />
      </Routes>
    </div>
  )
}

export default App
