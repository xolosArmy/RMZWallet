import type { Tm1PublishPhase } from './types'

export interface PublishStateMachineButtonProps {
  phase: Tm1PublishPhase
  onPublish: () => void | Promise<void>
  onReset?: () => void
  disabled?: boolean
  txid?: string | null
  error?: string | null
  explorerBaseUrl?: string
}

const DEFAULT_EXPLORER_BASE_URL = 'https://explorer.e.cash/tx/'

export function PublishStateMachineButton({
  phase,
  onPublish,
  onReset,
  disabled = false,
  txid,
  error,
  explorerBaseUrl = DEFAULT_EXPLORER_BASE_URL
}: PublishStateMachineButtonProps) {
  const isBusy =
    phase === 'verifying_ownership' ||
    phase === 'requesting_authorization' ||
    phase === 'broadcasting'

  const explorerLink = txid ? `${explorerBaseUrl}${txid}` : null

  return (
    <div className="publish-state-machine" data-testid="publish-state-machine">
      {/* Visual Stepper when busy or completed */}
      {(isBusy || phase === 'success') && (
        <div className="state-stepper card subtle" data-testid="state-stepper">
          <div
            className={`state-step ${
              phase === 'verifying_ownership'
                ? 'state-step--active'
                : phase === 'requesting_authorization' || phase === 'broadcasting' || phase === 'success'
                  ? 'state-step--completed'
                  : ''
            }`}
            data-testid="step-ownership"
          >
            <span className="state-step__num">1</span>
            <span className="state-step__label">Verificar Titularidad</span>
          </div>

          <div
            className={`state-step ${
              phase === 'requesting_authorization'
                ? 'state-step--active'
                : phase === 'broadcasting' || phase === 'success'
                  ? 'state-step--completed'
                  : ''
            }`}
            data-testid="step-authorization"
          >
            <span className="state-step__num">2</span>
            <span className="state-step__label">Solicitar Autorización</span>
          </div>

          <div
            className={`state-step ${
              phase === 'broadcasting'
                ? 'state-step--active'
                : phase === 'success'
                  ? 'state-step--completed'
                  : ''
            }`}
            data-testid="step-broadcasting"
          >
            <span className="state-step__num">3</span>
            <span className="state-step__label">Transmitir Memo</span>
          </div>
        </div>
      )}

      {/* Reconciling state */}
      {phase === 'reconciling' && (
        <div className="state-machine-action" role="status">
          <button
            type="button"
            className="cta primary is-loading"
            disabled
            aria-busy="true"
            data-testid="publish-button-reconciling"
          >
            <span className="spinner" aria-hidden="true" />
            Resolviendo publicación pendiente...
          </button>
        </div>
      )}

      {/* Idle state */}
      {phase === 'idle' && (
        <div className="state-machine-action">
          <button
            type="button"
            className="cta primary"
            onClick={onPublish}
            disabled={disabled}
            data-testid="publish-button-idle"
          >
            Publicar Tonalli Memo
          </button>
        </div>
      )}

      {/* Verifying ownership state */}
      {phase === 'verifying_ownership' && (
        <div className="state-machine-action" role="status">
          <button
            type="button"
            className="cta primary is-loading"
            disabled
            aria-busy="true"
            data-testid="publish-button-verifying"
          >
            <span className="spinner" aria-hidden="true" />
            1/3 Verificando titularidad (.xec)...
          </button>
        </div>
      )}

      {/* Requesting authorization state */}
      {phase === 'requesting_authorization' && (
        <div className="state-machine-action" role="status">
          <button
            type="button"
            className="cta primary is-loading"
            disabled
            aria-busy="true"
            data-testid="publish-button-authorizing"
          >
            <span className="spinner" aria-hidden="true" />
            2/3 Solicitando autorización y firma...
          </button>
        </div>
      )}

      {/* Broadcasting state */}
      {phase === 'broadcasting' && (
        <div className="state-machine-action" role="status">
          <button
            type="button"
            className="cta primary is-loading"
            disabled
            aria-busy="true"
            data-testid="publish-button-broadcasting"
          >
            <span className="spinner" aria-hidden="true" />
            3/3 Transmitiendo a la red eCash...
          </button>
        </div>
      )}

      {/* Success state */}
      {phase === 'success' && (
        <div className="card success-card" role="status" data-testid="publish-success-card">
          <div className="success-header">
            <span className="pill pill-success">✓ Publicación Exitosa</span>
            <h3 className="section-title">¡Tonalli Memo publicado con éxito!</h3>
            <p className="muted tx-meta">
              Tu mensaje ha sido verificado criptográficamente y difundido a la red eCash.
            </p>
          </div>

          {txid && (
            <div className="success-txid-box">
              <span className="memo-field-label">ID de Transacción (TXID)</span>
              <p className="monospace code-box tx-hash" data-testid="success-txid">
                {txid}
              </p>
              {explorerLink && (
                <div className="explorer-link-row">
                  <a
                    href={explorerLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="cta outline small memo-tx-link"
                    data-testid="explorer-link"
                  >
                    Ver en eCash Explorer ↗
                  </a>
                </div>
              )}
            </div>
          )}

          {onReset && (
            <div className="success-actions">
              <button
                type="button"
                className="cta outline"
                onClick={onReset}
                data-testid="publish-reset-button"
              >
                Crear otro memo
              </button>
            </div>
          )}
        </div>
      )}

      {/* Error state */}
      {phase === 'error' && (
        <div className="card error-card" role="alert" data-testid="publish-error-card">
          <div className="error-header">
            <span className="pill pill-error">⚠ Error en la publicación</span>
            <h3 className="section-title">No se pudo publicar el memo</h3>
            <p className="tx-meta error-text" data-testid="publish-error-message">
              {error || 'Ocurrió un error inesperado al procesar la publicación.'}
            </p>
          </div>

          <div className="error-actions">
            <button
              type="button"
              className="cta primary"
              onClick={onPublish}
              disabled={disabled}
              data-testid="publish-retry-button"
            >
              Reintentar publicación
            </button>
            {onReset && (
              <button
                type="button"
                className="cta outline"
                onClick={onReset}
                data-testid="publish-cancel-button"
              >
                Cancelar
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default PublishStateMachineButton
