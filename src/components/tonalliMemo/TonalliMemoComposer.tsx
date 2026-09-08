import { IdentityContext } from './IdentityContext'
import { MemoEditor } from './MemoEditor'
import { CanonicalPayloadPreview } from './CanonicalPayloadPreview'
import { PublishStateMachineButton } from './PublishStateMachineButton'
import { useTm1PublishMachine } from './useTm1PublishMachine'
import type { Tm1PublisherExecutor } from './types'

export interface TonalliMemoComposerProps {
  initialMessage?: string
  initialAlias?: string
  initialOwnerAddress?: string
  maxBytes?: number
  executor: Tm1PublisherExecutor
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
  onSuccess,
  onError,
  explorerBaseUrl
}: TonalliMemoComposerProps) {
  const {
    state,
    setMessage,
    verifyOwnership,
    publish,
    reset
  } = useTm1PublishMachine({
    initialMessage,
    initialAlias,
    initialOwnerAddress,
    maxBytes,
    executor,
    onSuccess,
    onError
  })

  const isFormDisabled =
    state.phase === 'verifying_ownership' ||
    state.phase === 'requesting_authorization' ||
    state.phase === 'broadcasting'

  return (
    <div className="memo-composer" data-testid="memo-composer">
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
