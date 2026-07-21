import { Link } from 'react-router-dom'
import TopBar from '../components/TopBar'

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
