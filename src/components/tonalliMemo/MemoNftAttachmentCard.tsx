import { useEffect, useState } from 'react'
import type { TonalliMemoAttachment } from '../../integrations/tonalliMemo/types'
import { fetchNftDetails, type NftDetails } from '../../services/nftService'

export interface MemoNftAttachmentCardProps {
  attachment: TonalliMemoAttachment
  onRemove?: () => void
  className?: string
}

function abbreviateTokenId(id: string): string {
  if (!id || id.length <= 12) return id
  return `${id.slice(0, 6)}...${id.slice(-6)}`
}

export function MemoNftAttachmentCard({
  attachment,
  onRemove,
  className = ''
}: MemoNftAttachmentCardProps) {
  const { tokenId, ownership } = attachment
  const isVerified = ownership === 'VERIFIED_AT_INDEXING'

  const [loading, setLoading] = useState<boolean>(isVerified)
  const [details, setDetails] = useState<NftDetails | null>(null)
  const [hasError, setHasError] = useState<boolean>(false)

  useEffect(() => {
    // For UNVERIFIED references, do not fetch or display full NFT asset as verified
    if (!isVerified || !tokenId) {
      setLoading(false)
      setDetails(null)
      return
    }

    let active = true
    setLoading(true)
    setHasError(false)

    fetchNftDetails(tokenId)
      .then((data) => {
        if (active) {
          setDetails(data)
          setLoading(false)
        }
      })
      .catch(() => {
        if (active) {
          setHasError(true)
          setLoading(false)
        }
      })

    return () => {
      active = false
    }
  }, [tokenId, isVerified])

  const name =
    (typeof details?.metadata?.name === 'string' && details.metadata.name) ||
    details?.genesisInfo?.tokenTicker ||
    'NFT'
  const imageUrl = details?.imageUrl

  if (!isVerified) {
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
      className={`memo-nft-attachment memo-nft-attachment--verified card ${className}`.trim()}
      data-testid="memo-nft-verified"
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
          {imageUrl && !hasError ? (
            <img
              src={imageUrl}
              alt={name}
              data-testid="memo-nft-image"
              onError={() => setHasError(true)}
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
              <span
                className="badge badge--success"
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
