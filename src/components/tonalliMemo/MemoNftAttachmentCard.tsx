import { useEffect, useMemo, useState } from 'react'
import type { TonalliMemoAttachment } from '../../integrations/tonalliMemo/types'
import {
  fetchNftDetails,
  getCachedMetadata,
  type NftDetails
} from '../../services/nftService'
import { getIpfsGatewayUrls, ipfsToGatewayUrl } from '../../utils/ipfs'

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

type NftAttribute = { trait_type?: string; value?: unknown }

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
  }>(() => {
    if (typeof window !== 'undefined' && tokenId) {
      const cached = getCachedMetadata(tokenId)
      if (cached?.metadata) {
        const rawImg = cached.metadata.image ? String(cached.metadata.image).trim() : ''
        const imgUrl = rawImg
          ? rawImg.startsWith('http://') || rawImg.startsWith('https://')
            ? rawImg
            : ipfsToGatewayUrl(rawImg) || ''
          : ''
        return {
          tokenId,
          details: {
            tokenId,
            metadata: cached.metadata,
            metadataCid: cached.metadataCid,
            imageUrl: imgUrl
          },
          hasError: false
        }
      }
    }
    return {
      tokenId,
      details: null,
      hasError: false
    }
  })

  const [imageState, setImageState] = useState<{
    tokenId: string
    attemptIndex: number
    hasError: boolean
  }>({
    tokenId,
    attemptIndex: 0,
    hasError: false
  })

  // Guard against stale metadata when tokenId changes
  const details = fetchStatus.tokenId === tokenId ? fetchStatus.details ?? null : null
  const hasError = fetchStatus.tokenId === tokenId ? Boolean(fetchStatus.hasError) : false

  const loading = !isSelection && isVerified && details === null && !hasError

  const currentAttemptIndex = imageState.tokenId === tokenId ? imageState.attemptIndex : 0
  const isImageFailedForCurrentToken =
    imageState.tokenId === tokenId ? imageState.hasError : false

  useEffect(() => {
    if (!needsFetch || !tokenId || (!isSelection && !isVerified)) {
      return
    }

    let active = true
    const controller = new AbortController()

    fetchNftDetails(tokenId, { signal: controller.signal })
      .then((data) => {
        if (active) {
          setFetchStatus({ tokenId, details: data, hasError: false })
        }
      })
      .catch(() => {
        if (active) {
          setFetchStatus({ tokenId, hasError: true })
        }
      })

    return () => {
      active = false
      controller.abort()
    }
  }, [tokenId, isVerified, isSelection, needsFetch])

  // Priority: metadata.name -> genesisInfo.tokenName -> genesisInfo.tokenTicker -> "NFT"
  const name =
    selectedAsset?.name ||
    (typeof details?.metadata?.name === 'string' && details.metadata.name.trim()) ||
    (typeof details?.genesisInfo?.tokenName === 'string' && details.genesisInfo.tokenName.trim()) ||
    (typeof details?.genesisInfo?.tokenTicker === 'string' && details.genesisInfo.tokenTicker.trim()) ||
    'NFT'

  const rawImage =
    selectedAsset?.imageUrl ||
    (details?.metadata?.image ? String(details.metadata.image).trim() : details?.imageUrl) ||
    ''

  const imageCandidates = useMemo(() => {
    if (!rawImage) return []
    if (rawImage.startsWith('http://') || rawImage.startsWith('https://')) {
      return [rawImage]
    }
    return getIpfsGatewayUrls(rawImage)
  }, [rawImage])

  const currentImageUrl =
    imageCandidates.length > 0 && currentAttemptIndex < imageCandidates.length
      ? imageCandidates[currentAttemptIndex]
      : selectedAsset?.imageUrl || details?.imageUrl || ''

  const hasImageError = isImageFailedForCurrentToken || hasError || !currentImageUrl

  const handleImageError = () => {
    if (currentAttemptIndex + 1 < imageCandidates.length) {
      setImageState({
        tokenId,
        attemptIndex: currentAttemptIndex + 1,
        hasError: false
      })
    } else {
      setImageState({
        tokenId,
        attemptIndex: currentAttemptIndex,
        hasError: true
      })
    }
  }

  const description =
    typeof details?.metadata?.description === 'string' ? details.metadata.description.trim() : null

  const collectionName =
    typeof details?.metadata?.collection === 'object' && details.metadata.collection !== null
      ? (details.metadata.collection as { name?: string }).name?.trim() || null
      : typeof details?.metadata?.collection === 'string'
      ? details.metadata.collection.trim() || null
      : null

  const attributes: NftAttribute[] = Array.isArray(details?.metadata?.attributes)
    ? (details.metadata.attributes as NftAttribute[]).filter(
        (attr) => attr && typeof attr === 'object' && ('value' in attr || 'trait_type' in attr)
      )
    : []

  // UNVERIFIED: Keep compact reference, warning badge, no metadata fetch/render as verified
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
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
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
          <span className="muted" style={{ fontSize: '0.8rem' }}>Referencia NFT:</span>
          <code title={tokenId} style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>
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

  // Selection mode (in TonalliMemoComposer preview)
  if (isSelection) {
    return (
      <div
        className={`memo-nft-attachment memo-nft-attachment--selection card ${className}`.trim()}
        data-testid="memo-nft-selection"
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
        {currentImageUrl && !hasImageError ? (
          <img
            src={currentImageUrl}
            alt={name}
            data-testid="memo-nft-image"
            onError={handleImageError}
            style={{
              width: '44px',
              height: '44px',
              borderRadius: '6px',
              objectFit: 'cover',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              flexShrink: 0
            }}
          />
        ) : (
          <div
            data-testid="memo-nft-placeholder"
            style={{
              width: '44px',
              height: '44px',
              borderRadius: '6px',
              background: 'rgba(255, 255, 255, 0.08)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '1.2rem',
              flexShrink: 0
            }}
          >
            🎨
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
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
      </div>
    )
  }

  // Read-model verified card: Complete, responsive visual presentation
  return (
    <div
      className={`memo-nft-attachment memo-nft-attachment--verified card ${className}`.trim()}
      data-testid="memo-nft-verified"
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: '0.85rem',
        padding: '0.75rem',
        margin: '0.5rem 0',
        borderRadius: '10px',
        border: '1px solid var(--border-color, #333)',
        background: 'var(--surface-color, rgba(255, 255, 255, 0.03))'
      }}
    >
      {loading ? (
        <div
          data-testid="memo-nft-loading"
          style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%', padding: '0.25rem' }}
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
          {/* Visual asset column (88-96px on mobile/desktop) */}
          <div style={{ flexShrink: 0, width: '92px', height: '92px', position: 'relative' }}>
            {currentImageUrl && !hasImageError ? (
              <img
                src={currentImageUrl}
                alt={name}
                data-testid="memo-nft-image"
                onError={handleImageError}
                style={{
                  width: '92px',
                  height: '92px',
                  borderRadius: '8px',
                  objectFit: 'cover',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  display: 'block'
                }}
              />
            ) : (
              <div
                data-testid="memo-nft-placeholder"
                style={{
                  width: '92px',
                  height: '92px',
                  borderRadius: '8px',
                  background: 'rgba(255, 255, 255, 0.06)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '2rem'
                }}
              >
                🎨
              </div>
            )}
          </div>

          {/* Details column */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              flex: 1,
              minWidth: 0,
              gap: '0.2rem'
            }}
          >
            {/* Name + Verified Badge */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
              <span
                data-testid="memo-nft-name"
                style={{
                  fontWeight: 600,
                  fontSize: '0.95rem',
                  color: 'var(--text-color, #fff)',
                  wordBreak: 'break-word'
                }}
              >
                {name}
              </span>
              <span
                className="badge badge--success"
                data-testid="memo-nft-verified-badge"
                style={{
                  padding: '2px 6px',
                  borderRadius: '4px',
                  background: 'rgba(40, 167, 69, 0.2)',
                  color: '#28a745',
                  fontWeight: 600,
                  fontSize: '0.7rem',
                  whiteSpace: 'nowrap'
                }}
              >
                NFT Verificado
              </span>
            </div>

            {/* Description brief */}
            {description && (
              <p
                data-testid="memo-nft-description"
                style={{
                  margin: '0.15rem 0',
                  fontSize: '0.8rem',
                  color: 'var(--muted-color, #aaa)',
                  lineHeight: 1.35,
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis'
                }}
              >
                {description}
              </p>
            )}

            {/* Collection */}
            {collectionName && (
              <div
                data-testid="memo-nft-collection"
                style={{
                  fontSize: '0.75rem',
                  color: 'var(--muted-color, #888)'
                }}
              >
                Colección:{' '}
                <span style={{ color: 'var(--text-color, #ddd)', fontWeight: 500 }}>
                  {collectionName}
                </span>
              </div>
            )}

            {/* Token ID */}
            <div style={{ fontSize: '0.75rem', color: 'var(--muted-color, #888)' }}>
              Token:{' '}
              <code
                data-testid="memo-nft-token-id"
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

            {/* Optional compact attributes */}
            {attributes.length > 0 && (
              <div
                data-testid="memo-nft-attributes"
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '0.3rem',
                  marginTop: '0.2rem'
                }}
              >
                {attributes.slice(0, 3).map((attr, idx) => (
                  <span
                    key={idx}
                    style={{
                      fontSize: '0.7rem',
                      padding: '1px 5px',
                      borderRadius: '3px',
                      background: 'rgba(255, 255, 255, 0.05)',
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                      color: 'var(--muted-color, #ccc)'
                    }}
                  >
                    {attr.trait_type ? `${attr.trait_type}: ` : ''}
                    {String(attr.value ?? '')}
                  </span>
                ))}
              </div>
            )}

            {onRemove && (
              <button
                type="button"
                className="button-link text-danger"
                onClick={onRemove}
                data-testid="memo-nft-remove-btn"
                style={{ fontSize: '0.8rem', cursor: 'pointer', alignSelf: 'flex-start', marginTop: '0.25rem' }}
              >
                Quitar NFT
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export default MemoNftAttachmentCard
