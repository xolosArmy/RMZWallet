import './polyfills'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App'
import { WalletProvider } from './context/WalletContext'
import { TonalliX402ApprovalProvider } from './context/TonalliX402ApprovalContext'
import { AgentWalletApprovalProvider } from './components/agentApproval/AgentWalletApprovalProvider'

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

// H3WC is a dormant candidate.  Keep the implementation out of the module
// graph at runtime unless the explicit hard flag is enabled; no legacy
// WalletConnect environment variable is consulted here.
if (String(import.meta.env.VITE_X402_H3WC_ENABLED).trim().toLowerCase() === 'true') {
  void import('./lib/h3wc/bootstrap').then(({ initializeH3wc }) => initializeH3wc({
    enabled: true,
    projectId: import.meta.env.VITE_X402_H3WC_PROJECT_ID,
    mode: import.meta.env.MODE,
    requesterOrigin: import.meta.env.VITE_X402_H3WC_REQUESTER_ORIGIN
  })).catch(error => {
    console.error('[H3WC] initialization failed closed', error)
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <WalletProvider>
        <TonalliX402ApprovalProvider>
          {/*
            CANONICAL WALLET-OWNED AGENT APPROVAL PROVIDER (Gate 2B)
            Explicit Security Boundary:
            AgentWalletApprovalProvider remains strictly non-operational (fails closed
            with MISSING_LEDGER_DEPENDENCY) while it does not receive a trusted, durable ledger.
            Zero in-memory fallback ledger in production.
          */}
          <AgentWalletApprovalProvider>
            <App />
          </AgentWalletApprovalProvider>
        </TonalliX402ApprovalProvider>
      </WalletProvider>
    </BrowserRouter>
  </StrictMode>
)
