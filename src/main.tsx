import './polyfills'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App'
import { WalletProvider } from './context/WalletContext'

const normalizeExternalSignHashRoute = () => {
  const hash = window.location.hash
  if (!hash.startsWith('#/external-sign')) return

  const hashRoute = hash.slice(1)
  const [hashPath, hashQuery] = hashRoute.split('?')
  if (hashPath !== '/external-sign') return

  const nextPath = `${hashPath}${hashQuery ? `?${hashQuery}` : ''}`
  const currentPath = `${window.location.pathname}${window.location.search}`
  if (currentPath === nextPath) return

  window.history.replaceState(null, '', nextPath)
}

normalizeExternalSignHashRoute()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <WalletProvider>
        <App />
      </WalletProvider>
    </BrowserRouter>
  </StrictMode>
)
