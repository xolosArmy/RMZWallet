import { useState } from 'react'
import { Link } from 'react-router-dom'
import TopBar from '../components/TopBar'
import { useWallet } from '../context/useWallet'
import { EXTENDED_GAP_LIMIT, xolosWalletService } from '../services/XolosWalletService'

function Settings() {
  const { rescanWallet, loading, initialized } = useWallet()
  const [rescanMessage, setRescanMessage] = useState<string | null>(null)
  const profile = xolosWalletService.getActiveDerivationProfile()
  const otherAssets = xolosWalletService.getOtherDetectedTokenAssets()

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
          <h1 className="section-title">Ajustes de wallet</h1>
          <p className="muted">Controles locales de respaldo, escaneo y preferencias de interfaz.</p>
        </div>
      </header>

      <div className="card">
        <h2>Perfil de derivación</h2>
        <p><strong>{profile.label}</strong></p>
        <p className="muted">BIP44 coin type: {profile.coinType}</p>
        <p className="muted">{profile.compatibility}</p>
      </div>

      {otherAssets.length > 0 && (
        <div className="card">
          <h2>Otros activos eCash detectados</h2>
          <p className="muted">Sólo diagnóstico. Tonalli no habilita el envío de tokens desconocidos.</p>
          {otherAssets.map(asset => (
            <p key={`${asset.tokenId}:${asset.protocol}:${asset.tokenType}`} className="muted">
              {asset.tokenId.slice(0, 12)}… · {asset.protocol}/{asset.tokenType} · {asset.utxoCount} UTXOs
            </p>
          ))}
        </div>
      )}

      <div className="card">
        <p className="muted">
          Aquí vivirá la exportación de seed (con autenticación local), cambio de idioma y la versión de la app.
        </p>
        <div className="actions">
          <button className="cta outline" type="button" onClick={handleRescan} disabled={!initialized || loading}>
            Re-escanear (extendido)
          </button>
          <Link className="cta ghost" to="/walletconnect">
            WalletConnect
          </Link>
        </div>
        {rescanMessage && <div className="muted">{rescanMessage}</div>}
      </div>
    </div>
  )
}

export default Settings
