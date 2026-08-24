import type { NftVerificationUiState } from '../../hooks/useNftVerification'

type NftVerificationBadgeProps = {
  readonly state: NftVerificationUiState
}

export function NftVerificationBadge({ state }: NftVerificationBadgeProps) {
  if (state.status === 'idle') {
    return null
  }

  if (state.status === 'loading') {
    return (
      <span className="nft-verification-badge is-loading" data-verification-status="loading">
        Verifying on-chain…
      </span>
    )
  }

  if (state.status === 'error') {
    return (
      <span className="nft-verification-badge is-error" data-verification-status="error">
        Verification unavailable
      </span>
    )
  }

  if (state.tier === 'official') {
    return (
      <span className="nft-verification-badge is-official" data-verification-status="official">
        VERIFIED LINEAGE
      </span>
    )
  }

  if (state.tier === 'community') {
    return (
      <span className="nft-verification-badge is-community" data-verification-status="community">
        COMMUNITY COLLECTION
      </span>
    )
  }

  return (
    <span className="nft-verification-badge is-unknown" data-verification-status="unknown">
      UNVERIFIED
    </span>
  )
}
