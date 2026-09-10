import { useEffect, useState } from 'react'
import type { TonalliMemoAttachment } from '../../integrations/tonalliMemo/types'
import { fetchNftDetails, type NftDetails } from '../../services/nftService'

export interface MemoNftAttachmentCardProps {
  attachment: TonalliMemoAttachment
  mode?: 'read_model' | 'selection'
  selectedAsset?: { name?: string; imageUrl?: string }
  onRemove?: () => void
  className?: string
}

function abbreviateTokenId(id: string): string {
  if (!id || id.length <= 12) return id
  return `${id.slice(0, 6)}...${id.slice(-6)}`
}

export function MemoNftAttachmentCard({
  attachment,
  mode = 'read_model',
  selectedAsset,
  onRemove,
  className = ''
}: MemoNftAttachmentCardProps) {
  const { tokenId, ownership } = attachment
  const isSelection = mode === 'selection'
  const isVerified = ownership === 'VERIFIED_AT_INDEXING'

  const needsFetch =
    Boolean(tokenId) &&
    ((!isSelection && isVerified) ||
      (isSelection && (!selectedAsset?.name || !selectedAsset?.imageUrl)))

  const [fetchStatus, setFetchStatus] = useState<{
    tokenId: string
    details?: NftDetails | null
    hasError?: boolean
  }>({
    tokenId,
    details: null,
    hasError: false
  })
  const [imageErrorToken, setImageErrorToken] = useState<string | null>(null)

  const details = fetchStatus.tokenId === tokenId ? fetchStatus.details ?? null : null
  const hasError = fetchStatus.tokenId === tokenId ? Boolean(fetchStatus.hasError) : false
  const hasImageError = (imageErrorToken === tokenId) || hasError

  const loading = !isSelection && isVerified && details === null && !hasError

  useEffect(() => {
    if (!needsFetch || !tokenId || (!isSelection && !isVerified)) {
      return
    }

    let active = true

    fetchNftDetails(tokenId)
      .then((data) => {
        if (active) {
          setFetchStatus({ tokenId, details: data })
        }
      })
      .catch(() => {
        if (active) {
          setFetchStatus({ tokenId, hasError: true })
        }
      })

    return () => {
      active = false
    }
  }, [tokenId, isVerified, isSelection, needsFetch])

  const name =
    selectedAsset?.name ||
    (typeof details?.metadata?.name === 'string' && details.metadata.name) ||
    details?.genesisInfo?.tokenTicker ||
    'NFT'
  const imageUrl = selectedAsset?.imageUrl || details?.imageUrl

  if (!isSelection && !isVerified) {
    return (
      <div
        className={`memo-nft-attachment memo-nft-attachment--unverified card subtle ${className}`.trim()}
        data-testid="memo-nft-unverified"
        role="status"
        aria-label="Referencia NFT no verificada"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0.5rem 0.75rem',
          margin: '0.5rem 0',
          borderRadius: '6px',
          border: '1px solid rgba(255, 193, 7, 0.4)',
          background: 'rgba(255, 193, 7, 0.05)',
          fontSize: '0.875rem'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span
            className="badge badge--warning"
            style={{
              padding: '2px 6px',
              borderRadius: '4px',
              background: '#ffc107',
              color: '#000',
              fontWeight: 600,
              fontSize: '0.75rem'
            }}
          >
            No verificado
          </span>
          <span className="muted">Referencia NFT:</span>
          <code title={tokenId} style={{ fontFamily: 'monospace' }}>
            {abbreviateTokenId(tokenId)}
          </code>
        </div>
        {onRemove && (
          <button
            type="button"
            className="button-link text-danger"
            onClick={onRemove}
            data-testid="memo-nft-remove-btn"
            style={{ marginLeft: 'auto', fontSize: '0.8rem', cursor: 'pointer' }}
          >
            Quitar
          </button>
        )}
      </div>
    )
  }

  return (
    <div
      className={`memo-nft-attachment ${isSelection ? 'memo-nft-attachment--selection' : 'memo-nft-attachment--verified'} card ${className}`.trim()}
      data-testid={isSelection ? 'memo-nft-selection' : 'memo-nft-verified'}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
        padding: '0.5rem 0.75rem',
        margin: '0.5rem 0',
        borderRadius: '8px',
        border: '1px solid var(--border-color, #333)',
        background: 'var(--surface-color, rgba(255, 255, 255, 0.03))'
      }}
    >
      {loading ? (
        <div
          data-testid="memo-nft-loading"
          style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%' }}
        >
          <div
            className="spinner-small"
            style={{
              width: '28px',
              height: '28px',
              borderRadius: '4px',
              background: 'rgba(255, 255, 255, 0.1)'
            }}
          />
          <span className="muted" style={{ fontSize: '0.85rem' }}>
            Cargando NFT ({abbreviateTokenId(tokenId)})...
          </span>
        </div>
      ) : (
        <>
          {imageUrl && !hasImageError ? (
            <img
              src={imageUrl}
              alt={name}
              data-testid="memo-nft-image"
              onError={() => setImageErrorToken(tokenId)}
              style={{
                width: '40px',
                height: '40px',
                borderRadius: '6px',
                objectFit: 'cover',
                border: '1px solid rgba(255, 255, 255, 0.1)'
              }}
            />
          ) : (
            <div
              data-testid="memo-nft-placeholder"
              style={{
                width: '40px',
                height: '40px',
                borderRadius: '6px',
                background: 'rgba(255, 255, 255, 0.08)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '1.1rem'
              }}
            >
              🎨
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span
                style={{
                  fontWeight: 600,
                  fontSize: '0.9rem',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                {name}
              </span>
              {isSelection ? (
                <span
                  className="badge badge--info"
                  data-testid="memo-nft-selection-badge"
                  style={{
                    padding: '1px 5px',
                    borderRadius: '3px',
                    background: 'rgba(59, 130, 246, 0.15)',
                    color: '#3b82f6',
                    fontWeight: 600,
                    fontSize: '0.7rem'
                  }}
                >
                  NFT seleccionado
                </span>
              ) : (
                <span
                  className="badge badge--success"
                  data-testid="memo-nft-verified-badge"
                  style={{
                    padding: '1px 5px',
                    borderRadius: '3px',
                    background: 'rgba(40, 167, 69, 0.2)',
                    color: '#28a745',
                    fontWeight: 600,
                    fontSize: '0.7rem'
                  }}
                >
                  NFT Verificado
                </span>
              )}
            </div>
            <code
              title={tokenId}
              style={{
                fontSize: '0.75rem',
                color: 'var(--muted-color, #888)',
                fontFamily: 'monospace'
              }}
            >
              {abbreviateTokenId(tokenId)}
            </code>
          </div>
          {onRemove && (
            <button
              type="button"
              className="button-link text-danger"
              onClick={onRemove}
              data-testid="memo-nft-remove-btn"
              style={{ fontSize: '0.8rem', cursor: 'pointer', marginLeft: 'auto' }}
            >
              Quitar NFT
            </button>
          )}
        </>
      )}
    </div>
  )
}

export default MemoNftAttachmentCard
