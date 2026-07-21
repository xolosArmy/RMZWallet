import { Link, useLocation } from 'react-router-dom'
import { useWallet } from '../context/useWallet'
import {
  isWalletNavigationActive,
  shouldShowWalletNavigation,
  walletNavigationItems
} from './walletNavigation'

function DesktopNavigation() {
  const { pathname } = useLocation()
  const { initialized } = useWallet()

  if (!shouldShowWalletNavigation(initialized, pathname)) return null

  return (
    <nav className="desktop-navigation" aria-label="Navegación principal de escritorio">
      {walletNavigationItems.map((item) => {
        const active = isWalletNavigationActive(item.id, pathname)
        return (
          <Link
            key={item.to}
            to={item.to}
            className={`desktop-navigation__item${active ? ' is-active' : ''}`}
            aria-current={active ? 'page' : undefined}
          >
            <span>{item.label}</span>
          </Link>
        )
      })}
    </nav>
  )
}

export default DesktopNavigation
