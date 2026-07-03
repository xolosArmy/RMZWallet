import { lazy, Suspense, useEffect, useState } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import Dashboard from './routes/Dashboard'
import SendRMZ from './routes/SendRMZ'
import SendXEC from './routes/SendXEC'
import RegisterAlias from './routes/RegisterAlias'
import Receive from './routes/Receive'
import Settings from './routes/Settings'
import Onboarding from './routes/Onboarding'
import BackupSeed from './routes/BackupSeed'
import { ScanQR } from './routes/ScanQR'
import RevealSeed from './routes/RevealSeed'
import DEX from './routes/DEX'
import Nfts from './routes/Nfts'
import SendNft from './routes/SendNft'
import ConnectRequest from './routes/ConnectRequest'
import WalletConnect from './routes/WalletConnect'
import ExternalSign from './routes/ExternalSign'
import CreateVault from './routes/multisig/CreateVault'
import VaultDashboard from './routes/multisig/VaultDashboard'
import CreateProposal from './routes/multisig/CreateProposal'
import SignProposal from './routes/multisig/SignProposal'
import ApproveRequestModal from './components/walletconnect/ApproveRequestModal'
import { wcWallet } from './lib/walletconnect/WcWallet'
import { X402_DRY_RUN_ENABLED } from './integrations/x402/x402DryRunFeature'
import { X402_STAGING_TEST_ENABLED } from './integrations/x402/x402StagingFeature'
const X402Demo = lazy(() => import('./routes/X402Demo'))
const X402Staging = lazy(() => import('./routes/X402Staging'))

function App() {
  const [wcState, setWcState] = useState(() => wcWallet.getState())

  useEffect(() => {
    const unsub = wcWallet.subscribe(setWcState)
    return () => {
      unsub()
    }
  }, [])

  return (
    <div className="app-shell">
      <div className="app-glow" aria-hidden />
      <main className="app-content">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/send" element={<SendRMZ />} />
          <Route path="/send-xec" element={<SendXEC />} />
          <Route path="/register-alias" element={<RegisterAlias />} />
          <Route path="/receive" element={<Receive />} />
          <Route path="/scan" element={<ScanQR />} />
          <Route path="/dex" element={<DEX />} />
          <Route path="/nfts" element={<Nfts />} />
          <Route path="/send-nft" element={<SendNft />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/connect" element={<ConnectRequest />} />
          <Route path="/connect/sign-message" element={<ConnectRequest />} />
          <Route path="/walletconnect" element={<WalletConnect />} />
          <Route path="/external-sign" element={<ExternalSign />} />
          <Route path="/multisig" element={<VaultDashboard />} />
          <Route path="/multisig/create" element={<CreateVault />} />
          <Route path="/multisig/:vaultId/propose" element={<CreateProposal />} />
          <Route path="/multisig/:vaultId/sign" element={<SignProposal />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/backup" element={<BackupSeed />} />
          <Route path="/reveal-seed" element={<RevealSeed />} />
          {X402_DRY_RUN_ENABLED && (
            <Route
              path="/x402-demo"
              element={<Suspense fallback={<div className="muted">Loading dry run…</div>}><X402Demo /></Suspense>}
            />
          )}
          {X402_STAGING_TEST_ENABLED && (
            <Route
              path="/x402-staging"
              element={<Suspense fallback={<div className="muted">Loading staging test…</div>}><X402Staging /></Suspense>}
            />
          )}
          <Route path="*" element={<Navigate to="/onboarding" replace />} />
        </Routes>
      </main>
      <ApproveRequestModal
        open={Boolean(wcState.pendingRequest)}
        request={wcState.pendingRequest}
        busy={wcState.pendingRequestBusy}
        error={wcState.pendingRequestError}
        resolved={wcState.pendingRequestResolved}
        status={wcState.pendingRequestStatus}
        successTxid={wcState.pendingRequestTxid}
        onApproved={() => void wcWallet.approvePendingRequest()}
        onRejected={() => void wcWallet.rejectPendingRequest()}
        onRetry={() => void wcWallet.rejectPendingRequest()}
      />
      {wcState.lastSuccessTxid && (
        <div
          className="success"
          style={{
            position: 'fixed',
            right: 18,
            bottom: 18,
            maxWidth: 420,
            zIndex: 70,
            wordBreak: 'break-all'
          }}
        >
          Compra completada. Txid: {wcState.lastSuccessTxid}
        </div>
      )}
      <footer className="app-footer">
        <a href="https://github.com/xolosArmy/RMZWallet" target="_blank" rel="noopener noreferrer">
          Código fuente en GitHub ↗
        </a>
      </footer>
    </div>
  )
}

export default App
