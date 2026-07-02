import { useEffect } from 'react'
import type { TonalliX402ApprovalDisplay } from '../../integrations/x402/TonalliX402ApprovalController'

type TonalliPaymentApprovalModalProps = {
  request: TonalliX402ApprovalDisplay
  onApprove: () => void
  onReject: () => void
  onCancel: () => void
}

const Detail = ({ label, value }: { label: string; value: string }) => (
  <div style={{ display: 'grid', gap: 4 }}>
    <span className="eyebrow" style={{ margin: 0 }}>{label}</span>
    <span style={{ overflowWrap: 'anywhere' }}>{value}</span>
  </div>
)

export default function TonalliPaymentApprovalModal({
  request,
  onApprove,
  onReject,
  onCancel
}: TonalliPaymentApprovalModalProps) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onCancel])

  const expiresAt = new Date(request.expiresAt * 1000).toISOString()

  return (
    <div
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
      style={{
        position: 'fixed', inset: 0, zIndex: 80, display: 'grid', placeItems: 'center',
        padding: 16, background: 'rgba(0, 0, 0, 0.78)', backdropFilter: 'blur(10px)'
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="tonalli-x402-title"
        style={{
          width: 'min(560px, 94vw)', maxHeight: '90vh', overflowY: 'auto', padding: 24,
          borderRadius: 24, border: '1px solid rgba(255, 122, 26, 0.35)',
          background: 'linear-gradient(145deg, rgba(5, 7, 12, 0.99), rgba(11, 17, 32, 0.99))',
          boxShadow: '0 24px 80px rgba(0, 0, 0, 0.55)'
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <p className="eyebrow">Tonalli · x402</p>
            <h2 id="tonalli-x402-title" className="section-title" style={{ fontSize: 24 }}>
              Aprobar pago XEC
            </h2>
          </div>
          <button
            type="button"
            aria-label="Cerrar solicitud"
            onClick={onCancel}
            style={{
              alignSelf: 'flex-start', border: 0, background: 'transparent',
              color: 'var(--muted)', fontSize: 24, cursor: 'pointer'
            }}
          >
            ×
          </button>
        </div>

        <div style={{
          display: 'grid', gap: 16, margin: '20px 0', padding: 18, borderRadius: 18,
          border: '1px solid var(--border)', background: 'var(--panel)'
        }}>
          <Detail label="Monto solicitado" value={`${request.amountXec} XEC (${request.amountSats} sats)`} />
          <Detail label="Dirección payTo" value={request.payTo} />
          <Detail label="Red" value={request.network} />
          <Detail label="Recurso" value={request.resource} />
          <Detail label="Expira" value={expiresAt} />
          <Detail
            label="Aprobación manual"
            value={request.requiresManualApproval ? 'Requerida' : 'No requerida por la política'}
          />
          {request.feeSats !== undefined && request.feeXec !== undefined && (
            <Detail label="Comisión estimada" value={`${request.feeXec} XEC (${request.feeSats} sats)`} />
          )}
        </div>

        <p className="muted" style={{ margin: '0 0 20px' }}>
          Aprobar autoriza únicamente la solicitud. No transmite ni paga una transacción.
        </p>
        <div className="actions" style={{ justifyContent: 'flex-end', gap: 12 }}>
          <button className="cta ghost" type="button" onClick={onReject}>Rechazar</button>
          <button className="cta" type="button" onClick={onApprove}>Aprobar</button>
        </div>
      </section>
    </div>
  )
}
