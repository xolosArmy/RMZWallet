import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { PendingRequest, PendingRequestStatus } from '../../lib/walletconnect/WcWallet'

type ApproveRequestModalProps = {
  open: boolean
  request: PendingRequest | null
  busy?: boolean
  error?: string | null
  resolved?: boolean
  status?: PendingRequestStatus
  successTxid?: string | null
  onApproved: () => void
  onRejected: () => void
  onRetry?: () => void
}

const SectionRow = ({ label, children }: { label: string; children: ReactNode }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
    <span style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.12em', opacity: 0.6 }}>{label}</span>
    <div style={{ fontSize: 14 }}>{children}</div>
  </div>
)

const statusLabel: Record<PendingRequestStatus, string> = {
  idle: 'Idle',
  pending: 'Pendiente',
  signing: 'Firmando',
  broadcasting: 'Transmitiendo',
  done: 'Completado',
  error: 'Error'
}

export default function ApproveRequestModal({
  open,
  request,
  busy = false,
  error,
  resolved = false,
  status = 'idle',
  successTxid,
  onApproved,
  onRejected,
  onRetry
}: ApproveRequestModalProps) {
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000))
  const [copyState, setCopyState] = useState<string | null>(null)

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNowSeconds(Math.floor(Date.now() / 1000))
    }, 1000)
    return () => window.clearInterval(interval)
  }, [])

  const expiresAt = request?.expiresAt ?? nowSeconds
  const remainingSeconds = Math.max(0, expiresAt - nowSeconds)
  const isExpired = remainingSeconds <= 0
  const isExpiredError = Boolean(error && /expired/i.test(error))
  const expiresSoon = remainingSeconds > 0 && remainingSeconds <= 30
  const countdownLabel = useMemo(() => {
    const minutes = Math.floor(remainingSeconds / 60)
    const seconds = remainingSeconds % 60
    return `${minutes}:${seconds.toString().padStart(2, '0')}`
  }, [remainingSeconds])

  if (!open || !request) return null

  const metadata = request.peer
  const icon = metadata?.icons?.[0]
  const params = request.params
  const verifyWarning = request.verifyContext?.warning
  const txPreview = request.rawTxPreview

  const handleCopyTxid = async () => {
    if (!successTxid || !navigator.clipboard?.writeText) return
    try {
      await navigator.clipboard.writeText(successTxid)
      setCopyState('Txid copiado')
      window.setTimeout(() => setCopyState(null), 1500)
    } catch {
      setCopyState('No se pudo copiar')
      window.setTimeout(() => setCopyState(null), 1500)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Ritual de Compra"
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
          gap: 20,
          maxHeight: '90vh',
          overflowY: 'auto'
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
              Ritual de Compra
            </p>
            <h2 className="section-title" style={{ fontSize: 22, letterSpacing: '0.08em' }}>
              Solicitud WalletConnect para firmar y transmitir.
            </h2>
          </div>
        </div>

        <div className="card" style={{ margin: 0, padding: 16, background: 'rgba(12,12,12,0.7)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {icon && (
              <img
                src={icon}
                alt={metadata?.name ? `${metadata.name} icon` : 'dApp icon'}
                style={{ width: 40, height: 40, borderRadius: 12, objectFit: 'cover' }}
              />
            )}
            <div>
              <p className="subtitle" style={{ marginBottom: 4 }}>
                {metadata?.name || 'dApp'}
              </p>
              <p className="muted" style={{ wordBreak: 'break-all' }}>
                {metadata?.url || 'Sin URL'}
              </p>
            </div>
          </div>
        </div>

        {verifyWarning && <div className="error">Warning: {verifyWarning}</div>}

        <div style={{ display: 'grid', gap: 16 }}>
          <SectionRow label="Estado">
            <span className="pill pill-ghost">{statusLabel[status]}</span>
          </SectionRow>
          <SectionRow label="Accion">{request.method}</SectionRow>
          <SectionRow label="Chain ID">{request.chainId}</SectionRow>
          <SectionRow label="Offer ID">
            <span className="pill pill-ghost" style={{ wordBreak: 'break-all' }}>
              {params.offerId}
            </span>
          </SectionRow>
          {params.userPrompt && <SectionRow label="Mensaje">{params.userPrompt}</SectionRow>}
          <SectionRow label="Expira en">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span
                className="pill"
                style={{
                  background: isExpired
                    ? 'rgba(248, 113, 113, 0.2)'
                    : expiresSoon
                      ? 'rgba(251, 191, 36, 0.2)'
                      : 'rgba(34, 197, 94, 0.2)',
                  borderColor: isExpired
                    ? 'rgba(248, 113, 113, 0.6)'
                    : expiresSoon
                      ? 'rgba(251, 191, 36, 0.6)'
                      : 'rgba(34, 197, 94, 0.6)',
                  color: isExpired ? '#fecaca' : expiresSoon ? '#fde68a' : '#bbf7d0'
                }}
              >
                {isExpired ? 'Expirada' : countdownLabel}
              </span>
              {expiresSoon && !isExpired && <span className="muted">Expira pronto.</span>}
            </div>
          </SectionRow>
          {params.rawHex && (
            <SectionRow label="rawHex">
              <span className="muted">{params.rawHex.slice(0, 32)}...</span>
            </SectionRow>
          )}
          {txPreview && (
            <SectionRow label="Resumen tx">
              <div style={{ display: 'grid', gap: 6 }}>
                <span className="muted">
                  {txPreview.inputs} inputs / {txPreview.outputs} outputs / {txPreview.bytes} bytes
                </span>
                <span className="muted">
                  Total outputs: {txPreview.totalOutputXec} XEC ({txPreview.totalOutputSats} sats)
                </span>
                {txPreview.feeXec && <span className="muted">Fee aprox: {txPreview.feeXec} XEC</span>}
                {txPreview.outputSummary.map((output, idx) => (
                  <span key={`${output.script}-${idx}`} className="muted">
                    Output {idx + 1}: {output.xec} XEC ({output.script}...)
                  </span>
                ))}
                {txPreview.summaryError && <span className="error">{txPreview.summaryError}</span>}
              </div>
            </SectionRow>
          )}
        </div>

        <div className="actions" style={{ justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <button className="cta ghost" type="button" onClick={onRejected} disabled={busy}>
            {resolved || isExpired ? 'Cerrar' : 'Rechazar'}
          </button>
          {(isExpired || isExpiredError) && onRetry && (
            <button
              className="cta"
              type="button"
              onClick={onRetry}
              disabled={busy}
              style={{
                background: 'linear-gradient(120deg, rgba(74, 222, 128, 0.95), rgba(34, 197, 94, 0.95))',
                boxShadow: '0 0 14px rgba(34, 197, 94, 0.35)',
                color: '#050505'
              }}
            >
              Reintentar
            </button>
          )}
          {!resolved && (
            <button
              className="cta"
              type="button"
              onClick={onApproved}
              disabled={busy || isExpired}
              style={{
                background: 'linear-gradient(120deg, rgba(249, 115, 22, 0.95), rgba(245, 158, 11, 0.95))',
                boxShadow: '0 0 14px rgba(249, 115, 22, 0.4)',
                color: '#050505'
              }}
            >
              {busy ? 'Procesando...' : isExpired ? 'Solicitud expirada' : 'Aprobar compra'}
            </button>
          )}
        </div>

        {isExpired && !resolved && (
          <div className="error">Esta solicitud expiró antes de ser aprobada. Regresa a la dApp y vuelve a intentarlo.</div>
        )}

        {resolved && successTxid && !error && (
          <div className="success" style={{ display: 'grid', gap: 8 }}>
            <div>Compra transmitida.</div>
            <div className="address-box" style={{ wordBreak: 'break-all' }}>
              {successTxid}
            </div>
            <button className="cta ghost" type="button" onClick={handleCopyTxid}>
              Copiar txid
            </button>
            {copyState && <span className="muted">{copyState}</span>}
          </div>
        )}

        {error && <div className="error">{error}</div>}
      </div>
    </div>
  )
}
