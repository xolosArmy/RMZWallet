import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useWallet } from '../context/WalletContext'

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
        <h1 className="title">Bienvenido</h1>
        <p className="muted">Configura tu billetera para ver tus saldos.</p>
        <div className="actions">
          <Link className="cta" to="/onboarding">
            Ir a onboarding
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <header className="header">
        <div>
          <p className="subtitle">xolosArmy Wallet</p>
          <h1 className="title">$RMZ es el protagonista</h1>
        </div>
        <div className="actions">
          <Link className="cta" to="/send">
            Enviar RMZ
          </Link>
          <Link className="cta secondary" to="/receive">
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
