import { Link } from 'react-router-dom'
import TopBar from '../components/TopBar'
import { useWallet } from '../context/useWallet'
import { WALLET_CAPABILITY } from '../domain/walletCapabilities'

const sendOptions = [
  {
    title: 'Enviar Xolos RMZ',
    description: 'Transfiere el eToken de acceso y gobernanza de xolosArmy Network.',
    to: '/send'
  },
  {
    title: 'Enviar eCash XEC',
    description: 'Envía dinero electrónico eCash directamente desde tu wallet.',
    to: '/send-xec'
  },
  {
    title: 'Enviar Firma Alpha',
    description: 'Transfiere FIRMA directamente a otra dirección eCash.',
    to: '/send-firma'
  },
  {
    title: 'Enviar NFT',
    description: 'Transfiere un NFT de linaje o coleccionable.',
    to: '/send-nft'
  },
  {
    title: 'Escanear código QR',
    description: 'Lee una dirección o solicitud compatible.',
    to: '/scan'
  }
]

function SendMenu() {
  const { hasCapability } = useWallet()
  if (!(hasCapability?.(WALLET_CAPABILITY.SEND_XEC) ?? true)) {
    return (
      <div className="page">
        <TopBar />
        <h1 className="section-title">Protege tu Tonalli para enviar</h1>
        <p className="muted">El envío se activa después de guardar tu frase de recuperación.</p>
        <div className="actions">
          <Link className="cta primary" to="/backup">Proteger ahora</Link>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <TopBar />
      <section className="section-header section-header--stacked">
        <div>
          <p className="eyebrow">Operaciones</p>
          <h1 className="section-title">¿Qué deseas enviar?</h1>
          <p className="muted">
            Selecciona el activo o tipo de operación. Tonalli Wallet prepara y firma cada transacción localmente en tu dispositivo.
          </p>
        </div>
      </section>

      <div className="hub-grid" aria-label="Opciones de envío">
        {sendOptions.map((option) => (
          <Link className="hub-card" to={option.to} key={option.to}>
            <span className="hub-card__title">{option.title}</span>
            <span className="hub-card__description">{option.description}</span>
          </Link>
        ))}
      </div>
    </div>
  )
}

export default SendMenu
