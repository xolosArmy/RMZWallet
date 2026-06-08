import type { AliasResolution } from '../hooks/useAliasResolution'

type AliasResolutionStatusProps = {
  resolution: AliasResolution
}

function AliasResolutionStatus({ resolution }: AliasResolutionStatusProps) {
  if (resolution.inputType === 'empty' || resolution.status === 'idle') return null

  if (resolution.status === 'loading') {
    return <p className="alias-status muted">Resolviendo alias .xec...</p>
  }

  if (resolution.status === 'error') {
    return <div className="alias-status error">{resolution.errorMessage}</div>
  }

  if (resolution.inputType === 'ecash-address') {
    return <p className="alias-status success">Dirección eCash válida</p>
  }

  if (resolution.inputType === 'alias' && resolution.resolvedAddress) {
    return (
      <div className="alias-status success">
        <p className="success-title">Alias confirmado</p>
        <p className="alias-resolution-line">
          <span>{resolution.alias}</span>
          <span aria-hidden="true">→</span>
          <span className="address-box">{resolution.resolvedAddress}</span>
        </p>
        {resolution.aliasRecord?.blockheight !== undefined && (
          <p className="muted alias-blockheight">Bloque: {resolution.aliasRecord.blockheight}</p>
        )}
      </div>
    )
  }

  return null
}

export default AliasResolutionStatus
