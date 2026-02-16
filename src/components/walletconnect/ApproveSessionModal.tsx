import { useState, type ReactNode } from 'react'
import { wcWallet } from '../../lib/walletconnect/WcWallet'

export type ProposalLike = {
  id: number
  params: {
    proposer: {
      metadata: {
        name?: string
        url?: string
        icons?: string[]
      }
    }
    requiredNamespaces: Record<string, { chains?: string[]; methods?: string[]; events?: string[] }>
    optionalNamespaces?: Record<string, { chains?: string[]; methods?: string[]; events?: string[] }>
  }
}

type ApproveSessionModalProps = {
  open: boolean
  proposal: ProposalLike | null
  activeAddress?: string | null
  onApproved: () => void
  onRejected?: () => void
  onClose?: () => void
}

type WalletConnectSignClient = {
  approve?: (args: { id: number; namespaces: Record<string, unknown> }) => Promise<unknown>
}

function getSignClient(): WalletConnectSignClient | null {
  const wallet = wcWallet as unknown as {
    web3wallet?: {
      approveSession?: (args: { id: number; namespaces: Record<string, unknown> }) => Promise<unknown>
      approve?: WalletConnectSignClient['approve']
    }
  }
  if (!wallet.web3wallet) return null
  return {
    approve: async (args) => {
      if (wallet.web3wallet?.approve) {
        return wallet.web3wallet.approve(args)
      }
      if (wallet.web3wallet?.approveSession) {
        return wallet.web3wallet.approveSession(args)
      }
      throw new Error('WalletConnect client no soporta approve().')
    }
  }
}

const SectionRow = ({ label, children }: { label: string; children: ReactNode }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
    <span style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.12em', opacity: 0.6 }}>{label}</span>
    <div style={{ fontSize: 14 }}>{children}</div>
  </div>
)

export default function ApproveSessionModal({
  open,
  proposal,
  activeAddress,
  onApproved,
  onRejected,
  onClose
}: ApproveSessionModalProps) {
  const [isApproving, setIsApproving] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)

  if (!open || !proposal) return null

  const metadata = proposal.params.proposer.metadata
  const icon = metadata.icons?.[0]
  const requiredNamespaces = proposal.params.requiredNamespaces
  const optionalNamespaces = proposal.params.optionalNamespaces ?? {}
  const proposalChains = Array.from(
    new Set([...(requiredNamespaces.ecash?.chains ?? []), ...(optionalNamespaces.ecash?.chains ?? [])])
  )
  const selectedChain = proposalChains.includes('ecash:1')
    ? 'ecash:1'
    : proposalChains.includes('ecash:mainnet')
      ? 'ecash:mainnet'
      : null
  const normalizedAddress = activeAddress
    ? activeAddress.startsWith('ecash:')
      ? activeAddress.slice('ecash:'.length)
      : activeAddress
    : null
  const addressLabel = normalizedAddress ? `${selectedChain ?? 'ecash:1'}:${normalizedAddress}` : 'Sin dirección activa'

  const handleApprove = async () => {
    setIsApproving(true)
    setErrorMsg(null)
    setSuccessMsg(null)

    console.log('[WC] approve click', { id: proposal.id, proposer: proposal.params?.proposer?.metadata })

    if (!activeAddress) {
      setErrorMsg('No hay dirección activa para aprobar el vínculo.')
      setIsApproving(false)
      return
    }
    if (!selectedChain) {
      const reason = 'Unsupported chain'
      console.warn('[WC] rejecting proposal due to unsupported chain', { id: proposal.id, proposalChains })
      await wcWallet.rejectSession(proposal.id, { code: 5100, message: reason })
      setErrorMsg(reason)
      setIsApproving(false)
      return
    }

    const approvedNamespaces = {
      ecash: {
        methods: ['ecash_getAddresses', 'ecash_signAndBroadcastTransaction'],
        chains: [selectedChain],
        events: ['accountsChanged', 'xolos_offer_published', 'xolos_offer_consumed'],
        accounts: normalizedAddress ? [`${selectedChain}:${normalizedAddress}`] : []
      }
    }

    console.log('[wc] approving proposal', {
      proposalChains,
      selectedChain,
      approvedNamespaces
    })

    try {
      const signClient = getSignClient()
      if (!signClient?.approve) {
        throw new Error('WalletConnect client aún no está inicializado.')
      }
      await signClient.approve({ id: proposal.id, namespaces: approvedNamespaces })
      wcWallet.refreshSessions()
      setSuccessMsg('Vínculo sellado ✓')
      onApproved()
      if (onClose) {
        await new Promise((resolve) => setTimeout(resolve, 600))
        onClose()
      }
    } catch (err) {
      console.error('[WC] approve failed', err)
      const message = err instanceof Error ? err.message : String(err)
      setErrorMsg(message)
    } finally {
      setIsApproving(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Ritual de Enlace"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.75)',
        backdropFilter: 'blur(10px)',
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16
      }}
    >
      <div
        style={{
          width: 'min(560px, 92vw)',
          borderRadius: 24,
          border: '1px solid rgba(245, 158, 11, 0.2)',
          background: 'rgba(5, 5, 5, 0.98)',
          boxShadow: '0 0 30px rgba(245, 158, 11, 0.12), 0 0 60px rgba(34, 197, 94, 0.08)',
          padding: 24,
          display: 'flex',
          flexDirection: 'column',
          gap: 20
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div
            aria-hidden
            style={{
              width: 56,
              height: 56,
              borderRadius: '50%',
              background: 'linear-gradient(135deg, rgba(245, 158, 11, 0.95), rgba(34, 197, 94, 0.85))',
              display: 'grid',
              placeItems: 'center',
              fontWeight: 700,
              letterSpacing: '0.12em',
              color: '#050505',
              boxShadow: '0 0 18px rgba(245, 158, 11, 0.4)'
            }}
          >
            RMZ
          </div>
          <div>
            <p className="eyebrow" style={{ marginBottom: 6, letterSpacing: '0.16em' }}>
              Ritual de Enlace
            </p>
            <h2 className="section-title" style={{ fontSize: 22, letterSpacing: '0.08em' }}>
              Una dApp solicita vínculo con tu guardián RMZ.
            </h2>
          </div>
        </div>

        <div className="card" style={{ margin: 0, padding: 16, background: 'rgba(12,12,12,0.7)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {icon && (
              <img
                src={icon}
                alt={metadata.name ? `${metadata.name} icon` : 'dApp icon'}
                style={{ width: 40, height: 40, borderRadius: 12, objectFit: 'cover' }}
              />
            )}
            <div>
              <p className="subtitle" style={{ marginBottom: 4 }}>
                {metadata.name || 'dApp'}
              </p>
              <p className="muted" style={{ wordBreak: 'break-all' }}>
                {metadata.url || 'Sin URL'}
              </p>
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gap: 16 }}>
          {Object.entries(requiredNamespaces).map(([namespace, config]) => (
            <div
              key={namespace}
              style={{
                borderRadius: 18,
                border: '1px solid rgba(148,163,184,0.2)',
                padding: 16,
                display: 'grid',
                gap: 12,
                background: 'rgba(12,12,12,0.6)'
              }}
            >
              <p style={{ fontSize: 13, letterSpacing: '0.14em', textTransform: 'uppercase' }}>{namespace}</p>
              <SectionRow label="Chains">{config.chains?.join(', ') || 'Sin cadenas'}</SectionRow>
              <SectionRow label="Methods">{config.methods?.join(', ') || 'Sin métodos'}</SectionRow>
              <SectionRow label="Events">{config.events?.join(', ') || 'Sin eventos'}</SectionRow>
            </div>
          ))}
        </div>

        <SectionRow label="Dirección anunciada">
          <span className="pill pill-ghost" style={{ wordBreak: 'break-all' }}>
            {addressLabel}
          </span>
        </SectionRow>

        {errorMsg && (
          <div
            style={{
              borderRadius: 12,
              border: '1px solid rgba(245, 158, 11, 0.5)',
              background: 'rgba(245, 158, 11, 0.12)',
              padding: '10px 12px',
              fontFamily: 'ui-monospace, SFMono-Regular, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
              fontSize: 12,
              color: '#f97316',
              wordBreak: 'break-word'
            }}
          >
            {errorMsg}
          </div>
        )}

        {successMsg && (
          <div
            style={{
              borderRadius: 12,
              border: '1px solid rgba(34, 197, 94, 0.55)',
              background: 'rgba(34, 197, 94, 0.12)',
              padding: '10px 12px',
              fontSize: 13,
              color: '#22c55e',
              letterSpacing: '0.03em'
            }}
          >
            {successMsg}
          </div>
        )}

        <div className="actions" style={{ justifyContent: 'space-between' }}>
          <button className="cta ghost" type="button" onClick={onRejected} disabled={isApproving}>
            Rechazar
          </button>
          <button
            className="cta"
            type="button"
            onClick={handleApprove}
            disabled={!activeAddress || isApproving}
            style={{
              background: 'linear-gradient(120deg, rgba(249, 115, 22, 0.95), rgba(245, 158, 11, 0.95))',
              boxShadow: '0 0 14px rgba(249, 115, 22, 0.4)',
              color: '#050505'
            }}
          >
            {isApproving ? 'Sellando vínculo...' : 'Aprobar vínculo'}
          </button>
        </div>
      </div>
    </div>
  )
}
