import { useState } from 'react'
import TopBar from '../components/TopBar'
import { useWallet } from '../context/useWallet'
import { EXTENDED_GAP_LIMIT } from '../services/XolosWalletService'

function Settings() {
  const { rescanWallet, loading, initialized } = useWallet()
  const [rescanMessage, setRescanMessage] = useState<string | null>(null)

  const handleRescan = async () => {
    setRescanMessage(null)
    try {
      await rescanWallet({ gapLimit: EXTENDED_GAP_LIMIT })
      setRescanMessage('Re-escaneo completado.')
    } catch (err) {
      setRescanMessage((err as Error).message || 'No se pudo re-escanear la billetera.')
    }
  }

  return (
    <div className="page">
      <TopBar />
      <header className="section-header">
        <div>
          <p className="eyebrow">Ajustes</p>
          <h1 className="section-title">Próximamente</h1>
          <p className="muted">Controles de respaldo, idioma y más vivirán aquí.</p>
        </div>
      </header>

      <div className="card">
        <p className="muted">
          Aquí vivirá la exportación de seed (con autenticación local), cambio de idioma y la versión de la app.
        </p>
        <div className="actions">
          <button className="cta outline" type="button" onClick={handleRescan} disabled={!initialized || loading}>
            Re-escanear (extendido)
          </button>
        </div>
        {rescanMessage && <div className="muted">{rescanMessage}</div>}
      </div>
    </div>
  )
}

export default Settings
