import { Link } from 'react-router-dom'
import TopBar from '../components/TopBar'
import { X402_DRY_RUN_ENABLED } from '../integrations/x402/x402DryRunFeature'
import { X402_STAGING_TEST_ENABLED } from '../integrations/x402/x402StagingFeature'

type MoreItem = {
  title: string
  description: string
  to: string
  caution?: boolean
}

type MoreSection = {
  id: string
  title: string
  items: MoreItem[]
}

const sections: MoreSection[] = [
  {
    id: 'ecosistema',
    title: 'Ecosistema',
    items: [
      { title: 'DEX / Agora', description: 'Explora ofertas y liquidez abiertas.', to: '/dex' },
      { title: 'Alias .xec', description: 'Registra identidad legible para direcciones eCash.', to: '/register-alias' },
      { title: 'Multifirma eCash', description: 'Coordina bóvedas y propuestas con varias firmas.', to: '/multisig' }
    ]
  },
  {
    id: 'conectividad',
    title: 'Conectividad',
    items: [
      { title: 'WalletConnect', description: 'Conecta Tonalli Wallet con dApps compatibles.', to: '/walletconnect' },
      { title: 'Escanear QR', description: 'Lee direcciones y solicitudes desde la cámara.', to: '/scan' }
    ]
  },
  {
    id: 'seguridad',
    title: 'Seguridad',
    items: [
      { title: 'Configuración', description: 'Revisa preferencias y estado local de la wallet.', to: '/settings' },
      {
        title: 'Ver frase de recuperación',
        description: 'Acceso sensible. Nunca compartas tu frase con soporte, sitios web o terceros.',
        to: '/reveal-seed',
        caution: true
      }
    ]
  }
]

const developmentItems: MoreItem[] = [
  ...(X402_DRY_RUN_ENABLED
    ? [{ title: 'Test 402 Authorization', description: 'Prueba local del flujo de autorización x402.', to: '/x402-demo' }]
    : []),
  ...(X402_STAGING_TEST_ENABLED
    ? [{ title: 'Test real staging authorization', description: 'Valida autorización contra staging controlado.', to: '/x402-staging' }]
    : [])
]

function More() {
  const visibleSections = developmentItems.length
    ? [...sections, { id: 'desarrollo', title: 'Desarrollo', items: developmentItems }]
    : sections

  return (
    <div className="page">
      <TopBar />
      <section className="section-header section-header--stacked">
        <div>
          <p className="eyebrow">Herramientas</p>
          <h1 className="section-title">Más</h1>
          <p className="muted">Accede a funciones secundarias sin mezclarlas con las operaciones cotidianas.</p>
        </div>
      </section>

      <div className="more-sections">
        {visibleSections.map((section) => (
          <section className="more-section" key={section.title} aria-labelledby={`more-${section.id}`}>
            <h2 id={`more-${section.id}`}>{section.title}</h2>
            <div className="hub-grid hub-grid--compact">
              {section.items.map((item) => (
                <Link className={`hub-card${item.caution ? ' hub-card--caution' : ''}`} to={item.to} key={item.to}>
                  <span className="hub-card__title">{item.title}</span>
                  <span className="hub-card__description">{item.description}</span>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

export default More
