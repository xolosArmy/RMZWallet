import { Link } from 'react-router-dom'
import { useWallet } from '../context/WalletContext'

function Receive() {
  const { address, initialized } = useWallet()

  if (!initialized) {
    return (
      <div className="page">
        <h1 className="title">Configura tu billetera</h1>
        <p className="muted">Ve al onboarding para generar o desbloquear tu seed.</p>
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
          <p className="subtitle">Recibir</p>
          <h1 className="title">Comparte tu dirección eCash</h1>
        </div>
      </header>

      <div className="card">
        <p className="muted">Puedes recibir RMZ y XEC en la misma dirección.</p>
        <div className="address-box">{address}</div>
      </div>
    </div>
  )
}

export default Receive
