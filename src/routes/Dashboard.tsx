import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useWallet } from '../context/WalletContext'
import TopBar from '../components/TopBar'

function Dashboard() {
  const { address, balance, initialized, refreshBalances, loading, error } = useWallet()

  useEffect(() => {
    if (initialized) {
      refreshBalances()
    }
  }, [initialized, refreshBalances])

  if (!initialized) {
    return (
      <div className="page">
        <TopBar />
        <h1 className="section-title">Bienvenido</h1>
        <p className="muted">Configura tu billetera para ver tus saldos.</p>
        <div className="actions">
          <Link className="cta primary" to="/onboarding">
            Ir a onboarding
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <TopBar />
      <header className="section-header">
        <div>
          <p className="eyebrow">Panel principal</p>
          <h1 className="section-title">Guardianía RMZ sobre eCash</h1>
          <p className="muted">
            Saldos, gas y tu dirección protegida en una sola vista. La seed nunca sale de tu dispositivo.
          </p>
        </div>
        <div className="actions">
          <Link className="cta primary" to="/send">
            Enviar RMZ
          </Link>
          <Link className="cta outline" to="/receive">
            Recibir
          </Link>
        </div>
      </header>

      <div className="grid">
        <div className="card">
          <p className="muted">Balance RMZ</p>
          <h2 style={{ marginTop: 4, fontSize: 32 }}>
            {balance ? `${balance.rmz} RMZ` : 'Cargando...'}
          </h2>
        </div>
        <div className="card">
          <p className="muted">Gas de red (XEC)</p>
          <h3 style={{ marginTop: 4 }}>{balance ? `${balance.xecFormatted} XEC` : 'Cargando...'}</h3>
          <p className="muted">({balance ? `${balance.xec} sats` : 'sats...'})</p>
        </div>
      </div>

      <div className="card">
        <p className="muted">Dirección eCash</p>
        <div className="address-box">{address}</div>
      </div>

      {loading && <div className="muted">Actualizando saldos...</div>}
      {error && <div className="error">{error}</div>}
    </div>
  )
}

export default Dashboard
