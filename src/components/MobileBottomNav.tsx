import type { ReactElement } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { isWalletNavigationActive, walletNavigationItems } from './walletNavigation'
import type { WalletNavigationItemId } from './walletNavigation'

type NavIconMap = Record<WalletNavigationItemId, ReactElement>

const IconHome = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
    <path d="M4 10.7 12 4l8 6.7V20a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1v-9.3Z" />
  </svg>
)

const IconSend = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
    <path d="M5 12h12.1l-4.6-4.6L14 6l7 7-7 7-1.5-1.4 4.6-4.6H5v-2Z" />
  </svg>
)

const IconReceive = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
    <path d="M19 12H6.9l4.6-4.6L10 6l-7 7 7 7 1.5-1.4L6.9 14H19v-2Z" />
  </svg>
)

const IconMemo = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
    <path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9.4L5 21v-3H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm1 3v8h1.2v2l2.8-2H18V7H6Zm2 2h8v2H8V9Zm0 3h5v2H8v-2Z" />
  </svg>
)

const IconMore = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
    <path d="M6 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z" />
  </svg>
)

const navIcons: NavIconMap = {
  home: <IconHome />,
  send: <IconSend />,
  memo: <IconMemo />,
  receive: <IconReceive />,
  more: <IconMore />
}

function MobileBottomNav() {
  const { pathname } = useLocation()

  return (
    <nav className="mobile-bottom-nav" aria-label="Navegación principal">
      {walletNavigationItems.map((item) => {
        const active = isWalletNavigationActive(item.id, pathname)
        return (
          <Link
            key={item.to}
            to={item.to}
            className={`mobile-bottom-nav__item${active ? ' is-active' : ''}`}
            aria-label={item.label}
            aria-current={active ? 'page' : undefined}
          >
            <span className="mobile-bottom-nav__icon">{navIcons[item.id]}</span>
            <span className="mobile-bottom-nav__label">{item.label}</span>
          </Link>
        )
      })}
    </nav>
  )
}

export default MobileBottomNav
