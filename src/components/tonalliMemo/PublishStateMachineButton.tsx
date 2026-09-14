import type { Tm1PublishPhase } from './types'

export interface PublishStateMachineButtonProps {
  phase: Tm1PublishPhase
  onPublish: () => void | Promise<void>
  onRetryIndexing?: () => void | Promise<void>
  onReset?: () => void
  disabled?: boolean
  txid?: string | null
  error?: string | null
  policyStatus?: string | null
  explorerBaseUrl?: string
}

const DEFAULT_EXPLORER_BASE_URL = 'https://explorer.e.cash/tx/'

export function PublishStateMachineButton({
  phase,
  onPublish,
  onRetryIndexing,
  onReset,
  disabled = false,
  txid,
  error,
  policyStatus,
  explorerBaseUrl = DEFAULT_EXPLORER_BASE_URL
}: PublishStateMachineButtonProps) {
  const isBusy =
    phase === 'verifying_ownership' ||
    phase === 'requesting_authorization' ||
    phase === 'broadcasting' ||
    phase === 'indexing_pending'

  const isPublishedOnChain =
    phase === 'indexing_pending' ||
    phase === 'indexing_delayed' ||
    phase === 'policy_rejected' ||
    phase === 'success'

  const explorerLink = txid ? `${explorerBaseUrl}${txid}` : null

  return (
    <div className="publish-state-machine" data-testid="publish-state-machine">
      {/* Visual Stepper when busy or completed */}
      {(isBusy || isPublishedOnChain) && (
        <div className="state-stepper card subtle" data-testid="state-stepper">
          <div
            className={`state-step ${
              phase === 'verifying_ownership'
                ? 'state-step--active'
                : phase === 'requesting_authorization' || phase === 'broadcasting' || isPublishedOnChain
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
                : phase === 'broadcasting' || isPublishedOnChain
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
                : isPublishedOnChain
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

      {phase === 'indexing_pending' && (
        <div className="card subtle" role="status" data-testid="publish-indexing-pending-card">
          <span className="pill">Publicado on-chain</span>
          <h3 className="section-title">Indexación pendiente</h3>
          <p className="muted tx-meta">
            La red eCash aceptó la transacción. Tonalli Memo está verificando el protocolo, la identidad y los adjuntos antes de mostrarla en el feed.
          </p>
          <PublishedTransaction txid={txid} explorerLink={explorerLink} />
        </div>
      )}

      {/* Success state */}
      {phase === 'success' && (
        <div className="card success-card" role="status" data-testid="publish-success-card">
          <div className="success-header">
            <span className="pill pill-success">✓ Verificado y visible</span>
            <h3 className="section-title">Tonalli Memo verificado y visible en el feed</h3>
            <p className="muted tx-meta">
              La transacción está publicada on-chain y aprobó la política de verificación del feed.
            </p>
          </div>

          <PublishedTransaction txid={txid} explorerLink={explorerLink} success />

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

      {phase === 'indexing_delayed' && (
        <div className="card subtle" role="status" data-testid="publish-indexing-delayed-card">
          <span className="pill">Publicado on-chain</span>
          <h3 className="section-title">La indexación sigue pendiente</h3>
          <p className="muted tx-meta">
            La publicación no fracasó: la transacción ya existe en eCash. Tonalli Memo no logró completar la verificación del feed en 60 segundos.
          </p>
          {error && <p className="tx-meta error-text">{error}</p>}
          <PublishedTransaction txid={txid} explorerLink={explorerLink} />
          <div className="success-actions">
            {onRetryIndexing && (
              <button type="button" className="cta primary" onClick={onRetryIndexing} data-testid="retry-indexing-button">
                Reintentar indexación
              </button>
            )}
            {onReset && (
              <button type="button" className="cta outline" onClick={onReset}>
                Crear otro memo
              </button>
            )}
          </div>
        </div>
      )}

      {phase === 'policy_rejected' && (
        <div className="card error-card" role="status" data-testid="publish-policy-rejected-card">
          <span className="pill pill-error">Publicado on-chain</span>
          <h3 className="section-title">La transacción existe, pero no cumple la política del feed</h3>
          <p className="muted tx-meta">
            Tonalli Memo la evaluó como <strong>{policyStatus || 'NO_VERIFICADA'}</strong>. No se volverá a transmitir ni se presentará como un fallo on-chain.
          </p>
          <PublishedTransaction txid={txid} explorerLink={explorerLink} />
          {onReset && (
            <div className="success-actions">
              <button type="button" className="cta outline" onClick={onReset}>
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

function PublishedTransaction({
  txid,
  explorerLink,
  success = false
}: {
  txid?: string | null
  explorerLink: string | null
  success?: boolean
}) {
  if (!txid) return null
  return (
    <div className="success-txid-box">
      <span className="memo-field-label">ID de Transacción (TXID)</span>
      <p
        className="monospace code-box tx-hash"
        data-testid={success ? 'success-txid' : 'published-txid'}
      >
        {txid}
      </p>
      {explorerLink && (
        <div className="explorer-link-row">
          <a
            href={explorerLink}
            target="_blank"
            rel="noopener noreferrer"
            className="cta outline small memo-tx-link"
            data-testid={success ? 'explorer-link' : 'published-explorer-link'}
          >
            Ver en eCash Explorer ↗
          </a>
        </div>
      )}
    </div>
  )
}
