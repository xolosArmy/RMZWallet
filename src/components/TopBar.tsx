import logo from '../assets/xolosarmy-logo-dark.png'

function TopBar() {
  return (
    <div className="topbar">
      <div className="brand">
        <div className="brand-mark">
          <img src={logo} alt="Logo XolosArmy" />
        </div>
        <div className="brand-copy">
          <p className="brand-title">RMZWallet</p>
          <p className="brand-subtitle">XolosArmy Network · eToken &amp; wallet on eCash (XEC)</p>
        </div>
      </div>
      <div className="status-pill" aria-hidden>
        <span className="dot" />
        Seguridad en tu dispositivo
      </div>
    </div>
  )
}

export default TopBar
