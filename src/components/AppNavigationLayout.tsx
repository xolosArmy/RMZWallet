import type { ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { useWallet } from '../context/useWallet'
import MobileBottomNav from './MobileBottomNav'
import { shouldShowWalletNavigation } from './walletNavigation'

type AppNavigationLayoutProps = {
  children: ReactNode
}

function AppNavigationLayout({ children }: AppNavigationLayoutProps) {
  const { pathname } = useLocation()
  const { initialized } = useWallet()
  const showMobileBottomNav = shouldShowWalletNavigation(initialized, pathname)

  return (
    <>
      <main className={`app-content${showMobileBottomNav ? ' app-content--mobile-nav' : ''}`}>
        {children}
      </main>
      <footer className={`app-footer${showMobileBottomNav ? ' app-footer--mobile-nav' : ''}`}>
        <span className="app-footer__mobile">
          Tonalli Wallet ·{' '}
          <a href="https://github.com/xolosArmy/RMZWallet" target="_blank" rel="noopener noreferrer">
            Open source
          </a>{' '}
          · xolosArmy Network
        </span>
        <span className="app-footer__desktop">
          Tonalli Wallet · Open source · Parte de xolosArmy Network ·{' '}
          <a href="https://github.com/xolosArmy/RMZWallet" target="_blank" rel="noopener noreferrer">
            Código fuente en GitHub
          </a>
          <span className="footer-claim"> · Verifica. Autocustodia. Libérate.</span>
        </span>
      </footer>
      {showMobileBottomNav && <MobileBottomNav />}
    </>
  )
}

export default AppNavigationLayout
