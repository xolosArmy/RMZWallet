import { lazy, Suspense, useEffect, useState } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import Dashboard from './routes/Dashboard'
import SendMenu from './routes/SendMenu'
import SendRMZ from './routes/SendRMZ'
import SendXEC from './routes/SendXEC'
import SendFirma from './routes/SendFirma'
import RegisterAlias from './routes/RegisterAlias'
import More from './routes/More'
import Receive from './routes/Receive'
import Settings from './routes/Settings'
import Onboarding, { CreateBackedWallet, CreateWallet, ExistingWallet, ImportWallet, ReadOnlyWallet, UnlockWallet } from './routes/Onboarding'
import QuickStartHydrator from './components/QuickStartHydrator'
import TonalliIntentCapture from './components/TonalliIntentCapture'
import BackupSeed from './routes/BackupSeed'
import { ScanQR } from './routes/ScanQR'
import RevealSeed from './routes/RevealSeed'
import DEX from './routes/DEX'
import Nfts from './routes/Nfts'
import MemoFeed from './routes/MemoFeed'
import MemoTx from './routes/MemoTx'
import MemoDraftPreview from './routes/MemoDraftPreview'
import MemoCompose from './routes/MemoCompose'
import SendNft from './routes/SendNft'
import ConnectRequest from './routes/ConnectRequest'
import WalletConnect from './routes/WalletConnect'
import ExternalSignDisabled from './routes/ExternalSign'
import CreateVault from './routes/multisig/CreateVault'
import VaultDashboard from './routes/multisig/VaultDashboard'
import CreateProposal from './routes/multisig/CreateProposal'
import SignProposal from './routes/multisig/SignProposal'
import ApproveRequestModal from './components/walletconnect/ApproveRequestModal'
import { RequireCapability } from './components/RequireCapability'
import { wcWallet } from './lib/walletconnect/WcWallet'
import {
  approveWalletConnectRequestIfAllowed,
  canUseWalletConnect,
  rejectDeniedWalletConnectRequest
} from './lib/walletconnect/walletConnectCapability'
import { useWallet } from './context/useWallet'
import { WALLET_CAPABILITY } from './domain/walletCapabilities'
import { X402_DRY_RUN_ENABLED } from './integrations/x402/x402DryRunFeature'
import { X402_STAGING_TEST_ENABLED } from './integrations/x402/x402StagingFeature'
import { X402_H3B_ENABLED } from './integrations/x402/x402H3BFeature'
import { TM_COMM_STAGING_ENABLED } from './config/tmCommStaging'
import AppNavigationLayout from './components/AppNavigationLayout'
const X402Demo = lazy(() => import('./routes/X402Demo'))
const X402Staging = lazy(() => import('./routes/X402Staging'))
const X402AuthorizeRequest = lazy(() => import('./routes/X402AuthorizeRequest'))
const TmCommStaging = lazy(() => import('./routes/TmCommStaging'))

function App() {
  const wallet = useWallet()
  const [wcState, setWcState] = useState(() => wcWallet.getState())
  const walletConnectAllowed = canUseWalletConnect(wallet)

  useEffect(() => {
    const unsub = wcWallet.subscribe(setWcState)
    return () => {
      unsub()
    }
  }, [])

  useEffect(() => {
    if (!wcState.pendingRequest || walletConnectAllowed) return
    void rejectDeniedWalletConnectRequest(wallet)
  }, [wallet, walletConnectAllowed, wcState.pendingRequest])

  return (
    <div className="app-shell">
      <div className="app-glow" aria-hidden />
      <QuickStartHydrator />
      <TonalliIntentCapture />
      <AppNavigationLayout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/send-menu" element={<SendMenu />} />
          <Route path="/send" element={<RequireCapability capability={WALLET_CAPABILITY.SEND_RMZ}><SendRMZ /></RequireCapability>} />
          <Route path="/send-xec" element={<RequireCapability capability={WALLET_CAPABILITY.SEND_XEC}><SendXEC /></RequireCapability>} />
          <Route path="/send-firma" element={<RequireCapability capability={WALLET_CAPABILITY.SEND_FIRMA}><SendFirma /></RequireCapability>} />
          <Route path="/register-alias" element={<RequireCapability capability={WALLET_CAPABILITY.ALIAS_SPEND_OPERATIONS}><RegisterAlias /></RequireCapability>} />
          <Route path="/receive" element={<Receive />} />
          <Route path="/scan" element={<ScanQR />} />
          <Route path="/dex" element={<RequireCapability capability={WALLET_CAPABILITY.AGORA_TRADING}><DEX /></RequireCapability>} />
          <Route path="/nfts" element={<RequireCapability capability={WALLET_CAPABILITY.NFT_OPERATIONS}><Nfts /></RequireCapability>} />
          <Route path="/memo" element={<MemoFeed />} />
          <Route path="/memo/compose" element={<RequireCapability capability={WALLET_CAPABILITY.ARBITRARY_BROADCAST}><MemoCompose /></RequireCapability>} />
          <Route path="/memo/draft/tm1" element={<MemoDraftPreview />} />
          <Route path="/memo/tx/:txid" element={<MemoTx />} />
          <Route path="/send-nft" element={<RequireCapability capability={WALLET_CAPABILITY.NFT_OPERATIONS}><SendNft /></RequireCapability>} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/connect" element={<RequireCapability capability={WALLET_CAPABILITY.EXTERNAL_SIGNING}><ConnectRequest /></RequireCapability>} />
          <Route path="/connect/sign-message" element={<RequireCapability capability={WALLET_CAPABILITY.EXTERNAL_SIGNING}><ConnectRequest /></RequireCapability>} />
          <Route path="/walletconnect" element={<RequireCapability capability={WALLET_CAPABILITY.WALLETCONNECT}><WalletConnect /></RequireCapability>} />
          <Route path="/more" element={<More />} />
          <Route path="/external-sign" element={<ExternalSignDisabled />} />
          <Route path="/multisig" element={<RequireCapability capability={WALLET_CAPABILITY.ARBITRARY_BROADCAST}><VaultDashboard /></RequireCapability>} />
          <Route path="/multisig/create" element={<RequireCapability capability={WALLET_CAPABILITY.ARBITRARY_BROADCAST}><CreateVault /></RequireCapability>} />
          <Route path="/multisig/:vaultId/propose" element={<RequireCapability capability={WALLET_CAPABILITY.ARBITRARY_BROADCAST}><CreateProposal /></RequireCapability>} />
          <Route path="/multisig/:vaultId/sign" element={<RequireCapability capability={WALLET_CAPABILITY.ARBITRARY_BROADCAST}><SignProposal /></RequireCapability>} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/onboarding/create" element={<CreateWallet />} />
          <Route path="/onboarding/create-backed" element={<CreateBackedWallet />} />
          <Route path="/onboarding/existing" element={<ExistingWallet />} />
          <Route path="/onboarding/unlock" element={<UnlockWallet />} />
          <Route path="/onboarding/import" element={<ImportWallet />} />
          <Route path="/onboarding/read-only" element={<ReadOnlyWallet />} />
          <Route path="/backup" element={<BackupSeed />} />
          <Route path="/reveal-seed" element={<RevealSeed />} />
          {X402_DRY_RUN_ENABLED && (
            <Route
              path="/x402-demo"
              element={(
                <RequireCapability capability={WALLET_CAPABILITY.X402}>
                  <Suspense fallback={<div className="muted">Cargando prueba seca...</div>}><X402Demo /></Suspense>
                </RequireCapability>
              )}
            />
          )}
          {X402_STAGING_TEST_ENABLED && (
            <Route
              path="/x402-staging"
              element={(
                <RequireCapability capability={WALLET_CAPABILITY.X402}>
                  <Suspense fallback={<div className="muted">Cargando prueba staging...</div>}><X402Staging /></Suspense>
                </RequireCapability>
              )}
            />
          )}
          {TM_COMM_STAGING_ENABLED && (
            <Route
              path="/tm-comm-staging"
              element={<Suspense fallback={<div className="muted">Cargando staging TM-COMM...</div>}><TmCommStaging /></Suspense>}
            />
          )}
          {X402_H3B_ENABLED && (
            <Route
              path="/connect/x402-authorize"
              element={(
                <RequireCapability capability={WALLET_CAPABILITY.X402}>
                  <Suspense fallback={<div className="muted">Validating authorization request…</div>}><X402AuthorizeRequest /></Suspense>
                </RequireCapability>
              )}
            />
          )}
          <Route path="*" element={<Navigate to="/onboarding" replace />} />
        </Routes>
      </AppNavigationLayout>
      <ApproveRequestModal
        open={walletConnectAllowed && Boolean(wcState.pendingRequest)}
        request={walletConnectAllowed ? wcState.pendingRequest : null}
        busy={wcState.pendingRequestBusy}
        error={wcState.pendingRequestError}
        resolved={wcState.pendingRequestResolved}
        status={wcState.pendingRequestStatus}
        successTxid={wcState.pendingRequestTxid}
        onApproved={() => {
          void approveWalletConnectRequestIfAllowed(wallet).catch(() => {
            void wcWallet.rejectPendingRequest()
          })
        }}
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
    </div>
  )
}

export default App
