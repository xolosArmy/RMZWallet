import type { Tm1VerificationStatus } from './types'

export interface IdentityContextProps {
  alias: string
  ownerAddress: string
  verificationStatus: Tm1VerificationStatus
  verificationError?: string | null
  onVerify?: () => void
  disabled?: boolean
}

export function IdentityContext({
  alias,
  ownerAddress,
  verificationStatus,
  verificationError,
  onVerify,
  disabled = false
}: IdentityContextProps) {
  const getStatusBadge = () => {
    switch (verificationStatus) {
      case 'verified':
        return (
          <span className="pill pill-success" data-testid="identity-status-verified">
            ✓ Titularidad verificada
          </span>
        )
      case 'verifying':
        return (
          <span className="pill pill-info" data-testid="identity-status-verifying">
            ⟳ Verificando titularidad...
          </span>
        )
      case 'failed':
        return (
          <span className="pill pill-error" data-testid="identity-status-failed">
            ⚠ Verificación fallida
          </span>
        )
      case 'unverified':
      default:
        return (
          <span className="pill pill-warning" data-testid="identity-status-unverified">
            ○ Pendiente de verificación
          </span>
        )
    }
  }

  return (
    <div className="card identity-context" data-testid="identity-context">
      <div className="identity-context__header">
        <div>
          <p className="eyebrow">Contexto de Identidad</p>
          <div className="identity-context__alias-row">
            <h3 className="identity-context__alias" data-testid="identity-alias">
              {alias}
            </h3>
            {getStatusBadge()}
          </div>
        </div>
        {onVerify && verificationStatus !== 'verifying' && verificationStatus !== 'verified' && (
          <button
            type="button"
            className="cta outline small"
            onClick={onVerify}
            disabled={disabled}
            data-testid="identity-verify-button"
          >
            Verificar ahora
          </button>
        )}
      </div>

      <div className="identity-context__details">
        <div>
          <span className="memo-field-label">Dirección propietaria (CashAddr)</span>
          <p className="tx-address monospace identity-context__address" data-testid="identity-address">
            {ownerAddress}
          </p>
        </div>
      </div>

      {verificationStatus === 'failed' && verificationError && (
        <div className="error tx-meta" role="alert" data-testid="identity-verification-error">
          <p className="tx-meta error-text">
            <strong>Error de titularidad:</strong> {verificationError}
          </p>
        </div>
      )}
    </div>
  )
}

export default IdentityContext
