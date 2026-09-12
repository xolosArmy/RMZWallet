/**
 * @file AgentExecutionReviewModal.tsx
 *
 * CANONICAL WALLET-OWNED FINAL EXECUTION REVIEW MODAL (Gate C2)
 *
 * Authority Boundary:
 * - Displays immutable transaction plan review snapshot before cryptographic signing.
 * - Prominent visual banner: "Firma local en dispositivo; NO transmite a la red."
 * - Separates network fee clearly from payment amount and calculates total wallet debit.
 * - Confirm action invokes local confirmation authority within Wallet boundary.
 * - Component has ZERO capability to broadcast or export raw signed transaction bytes.
 */

import { useState, useEffect, useCallback, type ReactElement } from 'react'
import type {
  SignedExecutionHandle,
  WalletExecutionReviewSession
} from '../../features/agentWalletExecution'
import type { WalletLocalConfirmationController } from '../../features/agentWalletExecution/types'

export interface AgentExecutionReviewModalProps {
  readonly session: WalletExecutionReviewSession
  readonly controller?: WalletLocalConfirmationController
  readonly onConfirmLocal?: () => Promise<SignedExecutionHandle>
  readonly isOpen: boolean
  readonly onExecutionSuccess?: (handle: SignedExecutionHandle) => void
  readonly onExecutionRejected?: () => void
  readonly onError?: (error: Error) => void
  readonly onClose: () => void
}

const DetailRow = ({
  label,
  value,
  highlight = false
}: {
  label: string
  value: string
  highlight?: boolean
}): ReactElement => (
  <div
    style={{
      display: 'grid',
      gap: 2,
      padding: '4px 0',
      borderBottom: '1px solid #1e293b'
    }}
  >
    <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: '#94a3b8' }}>
      {label}
    </span>
    <span
      style={{
        fontSize: highlight ? 15 : 13,
        fontWeight: highlight ? 'bold' : 'normal',
        wordBreak: 'break-all',
        fontFamily: 'monospace',
        color: highlight ? '#38bdf8' : '#f8fafc'
      }}
    >
      {value}
    </span>
  </div>
)

export function AgentExecutionReviewModal({
  session,
  controller,
  onConfirmLocal,
  isOpen,
  onExecutionSuccess,
  onExecutionRejected,
  onError,
  onClose
}: AgentExecutionReviewModalProps): ReactElement | null {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const handleDismiss = useCallback(async () => {
    if (!isSubmitting) {
      try {
        if (controller) {
          await controller.dismiss()
        } else {
          await session.dismiss()
        }
      } catch {
        // fail-safe ignore
      }
      onClose()
    }
  }, [isSubmitting, controller, session, onClose])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        void handleDismiss()
      }
    }
    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown)
    }
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, handleDismiss])

  if (!isOpen) return null

  const { review } = session

  const handleConfirm = async () => {
    if (isSubmitting) return
    setIsSubmitting(true)
    setErrorMessage(null)
    try {
      const handle = controller
        ? await controller.confirm()
        : onConfirmLocal
        ? await onConfirmLocal()
        : await (session as any).confirmExecution?.()

      if (!handle) {
        throw new Error('Local confirmation authority required to execute signing.')
      }
      onExecutionSuccess?.(handle)
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
    if (isSubmitting) return
    setIsSubmitting(true)
    setErrorMessage(null)
    try {
      if (controller) {
        await controller.reject('Execution rejected by custodian.')
      } else {
        await session.rejectExecution('Execution rejected by custodian.')
      }
      onExecutionRejected?.()
      onClose()
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      setErrorMessage(error.message)
      onError?.(error)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="execution-review-title"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.75)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        padding: 16
      }}
    >
      <div
        style={{
          backgroundColor: '#0f172a',
          border: '1px solid #334155',
          borderRadius: 8,
          width: '100%',
          maxWidth: 540,
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)'
        }}
      >
        {/* Header */}
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #1e293b' }}>
          <h2
            id="execution-review-title"
            style={{ margin: 0, fontSize: 18, color: '#f8fafc', fontWeight: 600 }}
          >
            Revisión Final de Ejecución (Gate C2)
          </h2>
          <div
            style={{
              marginTop: 8,
              padding: '6px 10px',
              backgroundColor: '#1e1b4b',
              border: '1px solid #4338ca',
              borderRadius: 4,
              fontSize: 12,
              color: '#c7d2fe',
              fontWeight: 500
            }}
          >
            🛡️ Firma local en dispositivo; NO transmite a la red.
          </div>
        </div>

        {/* Content */}
        <div style={{ padding: '16px 20px', overflowY: 'auto', flex: 1, display: 'grid', gap: 6 }}>
          <DetailRow label="Destinatario" value={review.recipient} />
          <DetailRow label="Monto a Pagar" value={review.amountXEC} highlight />
          <DetailRow label="Comisión de Red (Fee)" value={review.feeXEC} />
          <DetailRow
            label="Débito Total de Billetera"
            value={review.totalDebitXEC}
            highlight
          />
          <DetailRow label="Dirección Origen (Financiamiento)" value={review.fundingAddress} />
          <DetailRow label="Red" value={review.network} />
          <DetailRow label="Referencia de Aprobación" value={review.approvalId} />
          <DetailRow label="ID de Solicitud" value={review.requestId} />
          <DetailRow label="Hash de Plan" value={review.planHash} />

          {errorMessage && (
            <div
              role="alert"
              style={{
                marginTop: 8,
                padding: '8px 12px',
                backgroundColor: '#450a0a',
                border: '1px solid #991b1b',
                borderRadius: 4,
                color: '#fca5a5',
                fontSize: 12
              }}
            >
              {errorMessage}
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div
          style={{
            padding: '16px 20px',
            borderTop: '1px solid #1e293b',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 12
          }}
        >
          <button
            type="button"
            onClick={handleReject}
            disabled={isSubmitting}
            style={{
              padding: '8px 16px',
              borderRadius: 6,
              border: '1px solid #475569',
              backgroundColor: 'transparent',
              color: '#94a3b8',
              fontSize: 14,
              cursor: isSubmitting ? 'not-allowed' : 'pointer',
              opacity: isSubmitting ? 0.5 : 1
            }}
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={isSubmitting}
            style={{
              padding: '8px 20px',
              borderRadius: 6,
              border: 'none',
              backgroundColor: '#2563eb',
              color: '#ffffff',
              fontSize: 14,
              fontWeight: 600,
              cursor: isSubmitting ? 'not-allowed' : 'pointer',
              opacity: isSubmitting ? 0.5 : 1
            }}
          >
            {isSubmitting ? 'Firmando...' : 'Confirmar y Firmar'}
          </button>
        </div>
      </div>
    </div>
  )
}
