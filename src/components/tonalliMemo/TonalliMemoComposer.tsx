import { useState } from 'react'
import { IdentityContext } from './IdentityContext'
import { MemoEditor } from './MemoEditor'
import { CanonicalPayloadPreview } from './CanonicalPayloadPreview'
import { PublishStateMachineButton } from './PublishStateMachineButton'
import { useTm1PublishMachine } from './useTm1PublishMachine'
import { MemoNftAttachmentCard } from './MemoNftAttachmentCard'
import { fetchOwnedNfts, type NftAsset } from '../../services/nftService'
import type { Tm1AttachedNft, Tm1PublisherExecutor } from './types'
import type { Tm1PublicationRecoveryStore } from '../../integrations/tonalliMemo/recovery/tm1PublicationRecoveryStore'

export interface TonalliMemoComposerProps {
  initialMessage?: string
  initialAlias?: string
  initialOwnerAddress?: string
  initialAttachedNft?: Tm1AttachedNft | null
  maxBytes?: number
  executor: Tm1PublisherExecutor
  recoveryStore?: Tm1PublicationRecoveryStore
  onSuccess?: (txid: string) => void
  onError?: (error: Error) => void
  explorerBaseUrl?: string
}

function abbreviateTokenId(id: string): string {
  if (!id || id.length <= 12) return id
  return `${id.slice(0, 6)}...${id.slice(-6)}`
}

export function TonalliMemoComposer({
  initialMessage = '',
  initialAlias = '',
  initialOwnerAddress = '',
  initialAttachedNft = null,
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
    setAttachedNft,
    verifyOwnership,
    reconcilePending,
    publish,
    reset
  } = useTm1PublishMachine({
    initialMessage,
    initialAlias,
    initialOwnerAddress,
    initialAttachedNft,
    maxBytes,
    executor,
    recoveryStore,
    onSuccess,
    onError
  })

  const [isModalOpen, setIsModalOpen] = useState(false)
  const [ownedNfts, setOwnedNfts] = useState<NftAsset[]>([])
  const [isLoadingNfts, setIsLoadingNfts] = useState(false)
  const [nftFetchError, setNftFetchError] = useState<string | null>(null)

  const isFormDisabled =
    state.phase === 'reconciling' ||
    state.phase === 'verifying_ownership' ||
    state.phase === 'requesting_authorization' ||
    state.phase === 'broadcasting'

  const handleOpenNftSelector = async () => {
    setIsModalOpen(true)
    setIsLoadingNfts(true)
    setNftFetchError(null)
    try {
      const nfts = await fetchOwnedNfts(state.ownerAddress)
      setOwnedNfts(nfts)
    } catch (err) {
      setNftFetchError(err instanceof Error ? err.message : 'Error al cargar los NFTs de la billetera')
    } finally {
      setIsLoadingNfts(false)
    }
  }

  const handleSelectNft = (nft: NftAsset) => {
    setAttachedNft({
      tokenId: nft.tokenId,
      name: nft.name,
      imageUrl: nft.imageUrl
    })
    setIsModalOpen(false)
  }

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
            {state.error ? (
              <span className="error-text" data-testid="reconciliation-error-text">
                No se pudo consultar el almacén de recuperación: {state.error}.
                El editor permanece bloqueado por seguridad hasta verificar la ausencia de transacciones pendientes.
              </span>
            ) : (
              <>
                Se detectó una publicación previa en el almacén de recuperación duradero
                {(state.pendingRecord as any)?.publicationId
                  ? ` (${(state.pendingRecord as any).publicationId})`
                  : ''} en fase <code>{(state.pendingRecord as any)?.phase ?? 'outcomeUnknown'}</code>.
                El editor permanece bloqueado para evitar publicaciones duplicadas en la red eCash.
              </>
            )}
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
          maxBytes={state.effectiveUserMessageMaxBytes}
          showOverheadDetails={true}
          attachedNftTokenId={state.attachedNft?.tokenId}
          wirePayloadBytes={state.wirePayloadByteLength}
        />

        {/* NFT Attachment Toolbar & Selected Preview */}
        <div className="memo-composer__nft-toolbar" style={{ marginTop: '0.75rem' }}>
          {state.attachedNft ? (
            <div data-testid="memo-selected-nft-preview">
              <MemoNftAttachmentCard
                mode="selection"
                attachment={{
                  type: 'NFT',
                  tokenId: state.attachedNft.tokenId,
                  ownership: 'UNVERIFIED'
                }}
                selectedAsset={{
                  name: state.attachedNft.name,
                  imageUrl: state.attachedNft.imageUrl
                }}
                onRemove={isFormDisabled || state.phase === 'success' ? undefined : () => setAttachedNft(null)}
              />
            </div>
          ) : (
            <button
              type="button"
              className="button button--secondary small"
              onClick={handleOpenNftSelector}
              disabled={isFormDisabled || state.phase === 'success'}
              data-testid="memo-attach-nft-btn"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.35rem',
                cursor: isFormDisabled || state.phase === 'success' ? 'not-allowed' : 'pointer'
              }}
            >
              <span>📎</span>
              <span>Adjuntar NFT</span>
            </button>
          )}
        </div>
      </div>

      {/* NFT Selector Modal */}
      {isModalOpen && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="nft-selector-title"
          data-testid="nft-selector-modal"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '1rem'
          }}
        >
          <div
            className="modal-content card"
            style={{
              maxWidth: '520px',
              width: '100%',
              maxHeight: '80vh',
              display: 'flex',
              flexDirection: 'column',
              background: 'var(--surface-color, #1a1a1a)',
              border: '1px solid var(--border-color, #333)',
              borderRadius: '8px',
              padding: '1.25rem'
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '1rem'
              }}
            >
              <h3 id="nft-selector-title" style={{ margin: 0 }}>
                Seleccionar NFT para adjuntar
              </h3>
              <button
                type="button"
                className="button-link"
                onClick={() => setIsModalOpen(false)}
                data-testid="nft-selector-close-btn"
                style={{ cursor: 'pointer', fontSize: '1.2rem', padding: '0 4px' }}
              >
                ✕
              </button>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', marginBottom: '1rem' }}>
              {isLoadingNfts && (
                <div data-testid="nft-selector-loading" style={{ textAlign: 'center', padding: '2rem' }}>
                  <p className="muted">Buscando NFTs en tu billetera...</p>
                </div>
              )}

              {nftFetchError && (
                <p className="error-text" data-testid="nft-selector-error" role="alert">
                  {nftFetchError}
                </p>
              )}

              {!isLoadingNfts && !nftFetchError && ownedNfts.length === 0 && (
                <p className="muted" data-testid="nft-selector-empty" style={{ textAlign: 'center', padding: '2rem' }}>
                  No se encontraron NFTs en tu billetera activa.
                </p>
              )}

              {!isLoadingNfts && ownedNfts.length > 0 && (
                <div
                  className="nft-selector-grid"
                  style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}
                >
                  {ownedNfts.map((nft) => (
                    <button
                      key={nft.tokenId}
                      type="button"
                      className="nft-item card subtle"
                      onClick={() => handleSelectNft(nft)}
                      data-testid={`nft-select-item-${nft.tokenId}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.75rem',
                        padding: '0.5rem 0.75rem',
                        cursor: 'pointer',
                        textAlign: 'left',
                        background: 'transparent',
                        border: '1px solid var(--border-color, #333)',
                        borderRadius: '6px'
                      }}
                    >
                      {nft.imageUrl ? (
                        <img
                          src={nft.imageUrl}
                          alt={nft.name}
                          style={{
                            width: '36px',
                            height: '36px',
                            borderRadius: '4px',
                            objectFit: 'cover'
                          }}
                        />
                      ) : (
                        <div
                          style={{
                            width: '36px',
                            height: '36px',
                            borderRadius: '4px',
                            background: 'rgba(255,255,255,0.1)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center'
                          }}
                        >
                          🎨
                        </div>
                      )}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{nft.name || 'NFT'}</div>
                        <code style={{ fontSize: '0.75rem', color: '#888' }}>
                          {abbreviateTokenId(nft.tokenId)}
                        </code>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="button button--secondary small"
                onClick={() => setIsModalOpen(false)}
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 3. Canonical Payload Preview Component (Passes wirePayload!) */}
      <CanonicalPayloadPreview
        message={state.wirePayload}
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
