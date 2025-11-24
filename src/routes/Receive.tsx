import { Link } from 'react-router-dom'
import { useWallet } from '../context/WalletContext'
import TopBar from '../components/TopBar'

function Receive() {
  const { address, initialized } = useWallet()

  if (!initialized) {
    return (
      <div className="page">
        <TopBar />
        <h1 className="section-title">Configura tu billetera</h1>
        <p className="muted">Ve al onboarding para generar o desbloquear tu seed.</p>
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
          <p className="eyebrow">Recibir</p>
          <h1 className="section-title">Comparte tu dirección eCash</h1>
          <p className="muted">Recibe RMZ y XEC en la misma dirección cifrada en tu dispositivo.</p>
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
