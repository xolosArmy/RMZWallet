/**
 * @file AgentApprovalModal.tsx
 *
 * CANONICAL WALLET-OWNED AGENT APPROVAL MODAL (Gate 2B)
 *
 * Security Boundary:
 * - Displays immutable presentation snapshot prepared by trusted receiver.
 * - Prominent visual banner: "Aprobación únicamente; no firma ni transmite una transacción."
 * - Approve and Reject actions route strictly through receiver.approveHandle(handle)
 *   and receiver.rejectHandle(handle).
 * - Component has ZERO capability to sign, construct transactions, touch private keys,
 *   or access Chronik/x402 settlement.
 */

import { useState, useEffect, type ReactElement } from 'react'
import type { HumanApprovalV1 } from '@xolosarmy/tonalli-core'
import type {
  AgentWalletApprovalReceiver,
  WalletApprovalPresentation
} from '../../features/agentWalletApprovalReceiver'

export interface AgentApprovalModalProps {
  readonly handle: string
  readonly presentation: WalletApprovalPresentation
  readonly receiver: AgentWalletApprovalReceiver
  readonly isOpen: boolean
  readonly onApprovalSuccess?: (receipt: HumanApprovalV1) => void
  readonly onRejectionSuccess?: (receipt: HumanApprovalV1) => void
  readonly onError?: (error: Error) => void
  readonly onClose: () => void
}

const DetailRow = ({ label, value }: { label: string; value: string }): ReactElement => (
  <div style={{ display: 'grid', gap: 2, padding: '4px 0' }}>
    <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: '#94a3b8' }}>
      {label}
    </span>
    <span style={{ fontSize: 13, wordBreak: 'break-all', fontFamily: 'monospace', color: '#f8fafc' }}>
      {value}
    </span>
  </div>
)

export function AgentApprovalModal({
  handle,
  presentation,
  receiver,
  isOpen,
  onApprovalSuccess,
  onRejectionSuccess,
  onError,
  onClose
}: AgentApprovalModalProps): ReactElement | null {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [rejectReason, setRejectReason] = useState('')
  const [showRejectInput, setShowRejectInput] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isSubmitting) {
        receiver.dismissHandle(handle)
        onClose()
      }
    }
    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown)
    }
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, isSubmitting, handle, receiver, onClose])

  if (!isOpen) return null

  const handleApprove = async () => {
    setIsSubmitting(true)
    setErrorMessage(null)
    try {
      const receipt = await receiver.approveHandle(handle)
      onApprovalSuccess?.(receipt)
      onClose()
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      setErrorMessage(error.message)
      onError?.(error)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleReject = async () => {
    setIsSubmitting(true)
    setErrorMessage(null)
    try {
      const receipt = await receiver.rejectHandle(handle, {
        reason: rejectReason.trim() ? rejectReason.trim() : undefined
      })
      onRejectionSuccess?.(receipt)
      onClose()
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      setErrorMessage(error.message)
      onError?.(error)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleDismiss = () => {
    if (!isSubmitting) {
      receiver.dismissHandle(handle)
      onClose()
    }
  }

  return (
    <div
      role="presentation"
      data-testid="agent-approval-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !isSubmitting) {
          handleDismiss()
        }
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 90,
        display: 'grid',
        placeItems: 'center',
        padding: 16,
        background: 'rgba(0, 0, 0, 0.82)',
        backdropFilter: 'blur(8px)'
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-approval-title"
        data-testid="agent-approval-modal"
        style={{
          width: 'min(580px, 95vw)',
          maxHeight: '92vh',
          overflowY: 'auto',
          padding: 24,
          borderRadius: 20,
          border: '1px solid rgba(255, 122, 26, 0.45)',
          background: 'linear-gradient(150deg, #090d16 0%, #111827 100%)',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.7)',
          color: '#f8fafc',
          display: 'flex',
          flexDirection: 'column',
          gap: 16
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <p style={{ margin: 0, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1.5, color: '#f97316' }}>
              Tonalli · Agentes
            </p>
            <h2 id="agent-approval-title" style={{ margin: '4px 0 0 0', fontSize: 20, fontWeight: 700 }}>
              Revisión de Aprobación de Agente
            </h2>
          </div>
          <button
            type="button"
            onClick={handleDismiss}
            disabled={isSubmitting}
            aria-label="Cerrar"
            style={{
              background: 'transparent',
              border: 'none',
              color: '#94a3b8',
              fontSize: 20,
              cursor: isSubmitting ? 'not-allowed' : 'pointer',
              padding: 4
            }}
          >
            ✕
          </button>
        </div>

        {/* Security Notice Banner */}
        <div
          data-testid="security-notice-banner"
          style={{
            padding: '10px 14px',
            borderRadius: 8,
            backgroundColor: 'rgba(234, 88, 12, 0.15)',
            border: '1px solid rgba(249, 115, 22, 0.4)',
            color: '#fdba74',
            fontSize: 12,
            lineHeight: 1.4,
            fontWeight: 500
          }}
        >
          <strong>⚠️ Aviso de Seguridad:</strong> Aprobación únicamente; no firma ni transmite una transacción.
        </div>

        {/* Error Display */}
        {errorMessage && (
          <div
            data-testid="agent-approval-error"
            style={{
              padding: '10px 14px',
              borderRadius: 8,
              backgroundColor: 'rgba(239, 68, 68, 0.15)',
              border: '1px solid rgba(239, 68, 68, 0.4)',
              color: '#fca5a5',
              fontSize: 12
            }}
          >
            {errorMessage}
          </div>
        )}

        {/* Amount Presentation Card */}
        <div
          style={{
            padding: 16,
            borderRadius: 12,
            backgroundColor: 'rgba(15, 23, 42, 0.65)',
            border: '1px solid rgba(148, 163, 184, 0.15)',
            textAlign: 'center'
          }}
        >
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: '#94a3b8' }}>
            Monto Solicitado
          </div>
          <div style={{ fontSize: 28, fontWeight: 800, color: '#38bdf8', marginTop: 4 }}>
            {presentation.amountXEC}
          </div>
          <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
            ({presentation.amountSats} satoshis)
          </div>
        </div>

        {/* Detailed Fields Grid */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr',
            gap: 8,
            padding: 12,
            borderRadius: 12,
            backgroundColor: 'rgba(15, 23, 42, 0.4)',
            border: '1px solid rgba(148, 163, 184, 0.1)'
          }}
        >
          <DetailRow label="Destino" value={presentation.destination} />
          <DetailRow label="Dirección Origen (Custodio)" value={presentation.fromAddress} />
          <DetailRow label="Red" value={presentation.network} />
          <DetailRow label="Agente" value={`${presentation.agentId} (${presentation.agentRole})`} />
          <DetailRow label="Motivo del Intento" value={presentation.reason} />
          {presentation.memo && <DetailRow label="Memo" value={presentation.memo} />}
          <DetailRow label="Política CAE" value={`${presentation.policyReasonCode} (v${presentation.policyVersion})`} />
          <DetailRow label="Motivo de CAE" value={presentation.policyReason} />
          <DetailRow label="Trace ID" value={presentation.policyTraceId} />
          <DetailRow label="Expiración" value={presentation.effectiveExpiresAtIso} />
        </div>

        {/* Rejection reason input (optional toggle) */}
        {showRejectInput && (
          <div style={{ display: 'grid', gap: 4 }}>
            <label htmlFor="reject-reason" style={{ fontSize: 12, color: '#94a3b8' }}>
              Motivo del rechazo (opcional):
            </label>
            <input
              id="reject-reason"
              type="text"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Indica la razón del rechazo..."
              maxLength={500}
              disabled={isSubmitting}
              style={{
                padding: '8px 12px',
                borderRadius: 8,
                border: '1px solid #334155',
                backgroundColor: '#0f172a',
                color: '#f8fafc',
                fontSize: 13
              }}
            />
          </div>
        )}

        {/* Action Buttons */}
        <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
          {!showRejectInput ? (
            <button
              type="button"
              data-testid="reject-button-toggle"
              onClick={() => setShowRejectInput(true)}
              disabled={isSubmitting}
              style={{
                flex: 1,
                padding: '12px 16px',
                borderRadius: 10,
                border: '1px solid #dc2626',
                backgroundColor: 'rgba(220, 38, 38, 0.1)',
                color: '#f87171',
                fontWeight: 600,
                cursor: isSubmitting ? 'not-allowed' : 'pointer'
              }}
            >
              Rechazar
            </button>
          ) : (
            <button
              type="button"
              data-testid="confirm-reject-button"
              onClick={handleReject}
              disabled={isSubmitting}
              style={{
                flex: 1,
                padding: '12px 16px',
                borderRadius: 10,
                border: 'none',
                backgroundColor: '#dc2626',
                color: '#ffffff',
                fontWeight: 600,
                cursor: isSubmitting ? 'not-allowed' : 'pointer'
              }}
            >
              {isSubmitting ? 'Rechazando...' : 'Confirmar Rechazo'}
            </button>
          )}

          <button
            type="button"
            data-testid="approve-button"
            onClick={handleApprove}
            disabled={isSubmitting}
            style={{
              flex: 1,
              padding: '12px 16px',
              borderRadius: 10,
              border: 'none',
              backgroundColor: '#16a34a',
              color: '#ffffff',
              fontWeight: 600,
              cursor: isSubmitting ? 'not-allowed' : 'pointer'
            }}
          >
            {isSubmitting ? 'Aprobando...' : 'Aprobar Solicitud'}
          </button>
        </div>
      </section>
    </div>
  )
}
