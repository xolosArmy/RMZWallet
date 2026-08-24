import { useEffect, useRef, useState } from 'react'
import type { CollectionTier } from '../domain/nftCollections'
import {
  verifyNftCollection,
  type NftCollectionVerifier
} from '../features/nftVerification/nftVerification'

export type NftVerificationUiState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'resolved'; readonly tier: CollectionTier }
  | { readonly status: 'error' }

type VerificationSnapshot = {
  readonly childTokenId: string | null
  readonly verifier: NftCollectionVerifier | null
  readonly state: NftVerificationUiState
}

const IDLE_STATE: NftVerificationUiState = Object.freeze({ status: 'idle' })
const LOADING_STATE: NftVerificationUiState = Object.freeze({ status: 'loading' })

export function useNftVerification(
  childTokenId: string | null | undefined,
  verifier: NftCollectionVerifier = verifyNftCollection
): NftVerificationUiState {
  const requestGeneration = useRef(0)
  const [snapshot, setSnapshot] = useState<VerificationSnapshot>({
    childTokenId: null,
    verifier: null,
    state: IDLE_STATE
  })

  useEffect(() => {
    const generation = requestGeneration.current + 1
    requestGeneration.current = generation
    let active = true

    if (!childTokenId) {
      return () => {
        active = false
      }
    }

    void verifier(childTokenId).then(
      (outcome) => {
        if (!active || requestGeneration.current !== generation) return
        setSnapshot({ childTokenId, verifier, state: outcome })
      },
      () => {
        if (!active || requestGeneration.current !== generation) return
        setSnapshot({ childTokenId, verifier, state: { status: 'error' } })
      }
    )

    return () => {
      active = false
    }
  }, [childTokenId, verifier])

  if (!childTokenId) {
    return IDLE_STATE
  }

  if (snapshot.childTokenId !== childTokenId || snapshot.verifier !== verifier) {
    return LOADING_STATE
  }

  return snapshot.state
}
