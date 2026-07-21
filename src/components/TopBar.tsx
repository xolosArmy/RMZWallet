import BrandLogo from './BrandLogo'
import DesktopNavigation from './DesktopNavigation'

function TopBar() {
  return (
    <div className="topbar">
      <div className="brand">
        <div className="brand-mark">
          <BrandLogo variant="pictogram" alt="Pictograma derivado del logo oficial de Tonalli Wallet" />
        </div>
        <div className="brand-copy">
          <p className="brand-title">
            <span className="brand-title-full">Tonalli Wallet</span>
            <span className="brand-title-short">Tonalli</span>
          </p>
          <p className="brand-subtitle">Autocustodia para eCash, Xolos RMZ e identidad on-chain</p>
        </div>
      </div>
      <div className="status-pill" role="status">
        <span className="dot" />
        Llaves en tu dispositivo
      </div>
      <DesktopNavigation />
    </div>
  )
}

export default TopBar
