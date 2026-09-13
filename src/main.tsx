import './polyfills'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App'
import { WalletProvider } from './context/WalletContext'
import { TonalliX402ApprovalProvider } from './context/TonalliX402ApprovalContext'
import { AgentWalletApprovalProvider } from './components/agentApproval/AgentWalletApprovalProvider'
import {
  TrustedGate2bToC2Bridge,
  TrustedWalletExecutionProvider,
  createProductionWalletRuntime
} from './internal/agentWalletExecutionHost'

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

const productionWalletRuntime = createProductionWalletRuntime()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <WalletProvider>
        <TonalliX402ApprovalProvider>
          {/*
            Shared durable WalletApprovalLedger is constructed once and injected
            into both Gate 2B and Gate C2. If production dependencies cannot be
            constructed, both remain fail-closed (no empty/throwing C2 defaults).
          */}
          <TrustedWalletExecutionProvider
            approvalLedger={productionWalletRuntime?.approvalLedger}
            sessionVerifier={productionWalletRuntime?.sessionVerifier}
            utxoProvider={productionWalletRuntime?.utxoProvider}
            ledgerStorage={productionWalletRuntime?.ledgerStorage}
          >
            <AgentWalletApprovalProvider ledger={productionWalletRuntime?.approvalLedger}>
              <TrustedGate2bToC2Bridge>
                <App />
              </TrustedGate2bToC2Bridge>
            </AgentWalletApprovalProvider>
          </TrustedWalletExecutionProvider>
        </TonalliX402ApprovalProvider>
      </WalletProvider>
    </BrowserRouter>
  </StrictMode>
)
