import { Link, useLocation } from 'react-router-dom'
import { useWallet } from '../context/useWallet'
import { WALLET_CAPABILITY } from '../domain/walletCapabilities'
import {
  isWalletNavigationActive,
  shouldShowWalletNavigation,
  walletNavigationItemsForCapabilities
} from './walletNavigation'

function DesktopNavigation() {
  const { pathname } = useLocation()
  const { initialized, hasCapability } = useWallet()

  if (!shouldShowWalletNavigation(initialized, pathname)) return null
  const items = walletNavigationItemsForCapabilities(hasCapability?.(WALLET_CAPABILITY.SEND_XEC) ?? true)

  return (
    <nav className="desktop-navigation" aria-label="Navegación principal de escritorio">
      {items.map((item) => {
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
