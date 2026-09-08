import { IdentityContext } from './IdentityContext'
import { MemoEditor } from './MemoEditor'
import { CanonicalPayloadPreview } from './CanonicalPayloadPreview'
import { PublishStateMachineButton } from './PublishStateMachineButton'
import { useTm1PublishMachine } from './useTm1PublishMachine'
import type { Tm1PublisherExecutor } from './types'
import type { Tm1PublicationRecoveryStore } from '../../integrations/tonalliMemo/recovery/tm1PublicationRecoveryStore'

export interface TonalliMemoComposerProps {
  initialMessage?: string
  initialAlias?: string
  initialOwnerAddress?: string
  maxBytes?: number
  executor: Tm1PublisherExecutor
  recoveryStore?: Tm1PublicationRecoveryStore
  onSuccess?: (txid: string) => void
  onError?: (error: Error) => void
  explorerBaseUrl?: string
}

export function TonalliMemoComposer({
  initialMessage = '',
  initialAlias = '',
  initialOwnerAddress = '',
  maxBytes,
  executor,
  recoveryStore,
  onSuccess,
  onError,
  explorerBaseUrl
}: TonalliMemoComposerProps) {
  const {
    state,
    setMessage,
    verifyOwnership,
    reconcilePending,
    publish,
    reset
  } = useTm1PublishMachine({
    initialMessage,
    initialAlias,
    initialOwnerAddress,
    maxBytes,
    executor,
    recoveryStore,
    onSuccess,
    onError
  })

  const isFormDisabled =
    state.phase === 'reconciling' ||
    state.phase === 'verifying_ownership' ||
    state.phase === 'requesting_authorization' ||
    state.phase === 'broadcasting'

  return (
    <div className="memo-composer" data-testid="memo-composer">
      {/* 0. Pending Recovery Reconciliation Notice */}
      {state.phase === 'reconciling' && (
        <div
          className="card memo-reconciling-state"
          data-testid="memo-reconciling-state"
          style={{ marginBottom: '1.25rem', borderColor: 'var(--color-warning, #f59e0b)' }}
        >
          <div className="state-badge warning" data-testid="reconciling-badge">
            Publicación pendiente en resolución
          </div>
          <h2 className="card-title" style={{ marginTop: '0.5rem' }}>
            Publicación en curso o pendiente de verificación
          </h2>
          <p className="muted">
            Se detectó una publicación previa en el almacén de recuperación duradero
            {(state.pendingRecord as any)?.publicationId
              ? ` (${(state.pendingRecord as any).publicationId})`
              : ''} en fase <code>{(state.pendingRecord as any)?.phase ?? 'outcomeUnknown'}</code>.
            El editor permanece bloqueado para evitar publicaciones duplicadas en la red eCash.
          </p>
          <div
            className="reconciliation-actions"
            style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem', flexWrap: 'wrap' }}
          >
            <button
              type="button"
              className="cta outline small"
              onClick={reconcilePending}
              data-testid="reconcile-chronik-btn"
            >
              Verificar en Chronik
            </button>
          </div>
        </div>
      )}
      {/* 1. Identity Context Component */}
      <IdentityContext
        alias={state.alias}
        ownerAddress={state.ownerAddress}
        verificationStatus={state.verificationStatus}
        verificationError={state.verificationError}
        onVerify={verifyOwnership}
        disabled={isFormDisabled}
      />

      {/* 2. Memo Editor Component */}
      <div className="card memo-composer__editor-card">
        <MemoEditor
          value={state.message}
          onChange={setMessage}
          disabled={isFormDisabled || state.phase === 'success'}
          maxBytes={state.maxBytes}
          showOverheadDetails={true}
        />
      </div>

      {/* 3. Canonical Payload Preview Component */}
      <CanonicalPayloadPreview
        message={state.message}
        authorInputIndex={0}
        preview={state.preview}
        error={state.previewError}
      />

      {/* 4. Visual State Machine & Action Button */}
      <div className="memo-composer__actions">
        <PublishStateMachineButton
          phase={state.phase}
          onPublish={publish}
          onReset={reset}
          disabled={!state.isValid || isFormDisabled}
          txid={state.txid}
          error={state.error}
          explorerBaseUrl={explorerBaseUrl}
        />
      </div>
    </div>
  )
}

export default TonalliMemoComposer
