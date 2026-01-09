import { Navigate, Route, Routes } from 'react-router-dom'
import Dashboard from './routes/Dashboard'
import SendRMZ from './routes/SendRMZ'
import SendXEC from './routes/SendXEC'
import Receive from './routes/Receive'
import Settings from './routes/Settings'
import Onboarding from './routes/Onboarding'
import BackupSeed from './routes/BackupSeed'
import { ScanQR } from './routes/ScanQR'
import RevealSeed from './routes/RevealSeed'
import DEX from './routes/DEX'
import Nfts from './routes/Nfts'
import SendNft from './routes/SendNft'

function App() {
  return (
    <div className="app-shell">
      <div className="app-glow" aria-hidden />
      <main className="app-content">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/send" element={<SendRMZ />} />
          <Route path="/send-xec" element={<SendXEC />} />
          <Route path="/receive" element={<Receive />} />
          <Route path="/scan" element={<ScanQR />} />
          <Route path="/dex" element={<DEX />} />
          <Route path="/nfts" element={<Nfts />} />
          <Route path="/send-nft" element={<SendNft />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/backup" element={<BackupSeed />} />
          <Route path="/reveal-seed" element={<RevealSeed />} />
          <Route path="*" element={<Navigate to="/onboarding" replace />} />
        </Routes>
      </main>
      <footer className="app-footer">
        <a href="https://github.com/xolosArmy/RMZWallet" target="_blank" rel="noopener noreferrer">
          Código fuente en GitHub ↗
        </a>
      </footer>
    </div>
  )
}

export default App
