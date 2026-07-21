import type { ReactElement } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { isMobileBottomNavActive } from './mobileBottomNavRules'

type NavItem = {
  label: string
  to: string
  match: (pathname: string) => boolean
  icon: ReactElement
}

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

const IconNfts = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
    <path d="M6 4h7l5 5v11H6V4Zm8 1.8V10h4.2L14 5.8ZM8 12v6h8v-6H8Z" />
  </svg>
)

const IconMore = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
    <path d="M6 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z" />
  </svg>
)

const navItems: NavItem[] = [
  { label: 'Inicio', to: '/', match: (pathname) => isMobileBottomNavActive('home', pathname), icon: <IconHome /> },
  { label: 'Enviar', to: '/send-menu', match: (pathname) => isMobileBottomNavActive('send', pathname), icon: <IconSend /> },
  { label: 'Recibir', to: '/receive', match: (pathname) => isMobileBottomNavActive('receive', pathname), icon: <IconReceive /> },
  { label: 'NFTs', to: '/nfts', match: (pathname) => isMobileBottomNavActive('nfts', pathname), icon: <IconNfts /> },
  { label: 'Más', to: '/more', match: (pathname) => isMobileBottomNavActive('more', pathname), icon: <IconMore /> }
]

function MobileBottomNav() {
  const { pathname } = useLocation()

  return (
    <nav className="mobile-bottom-nav" aria-label="Navegación principal">
      {navItems.map((item) => {
        const active = item.match(pathname)
        return (
          <Link
            key={item.to}
            to={item.to}
            className={`mobile-bottom-nav__item${active ? ' is-active' : ''}`}
            aria-label={item.label}
            aria-current={active ? 'page' : undefined}
          >
            <span className="mobile-bottom-nav__icon">{item.icon}</span>
            <span className="mobile-bottom-nav__label">{item.label}</span>
          </Link>
        )
      })}
    </nav>
  )
}

export default MobileBottomNav
