import { classifyCollection, type CollectionTier } from '../../domain/nftCollections'
import { getChronik } from '../../services/ChronikClient'
import {
  extractNftCollectionEvidence,
  type NftEvidenceChronikReader
} from '../../services/nftEvidenceExtractor'

export type NftVerificationOutcome =
  | { readonly status: 'resolved'; readonly tier: CollectionTier }
  | { readonly status: 'error' }

type ResolvedNftVerificationOutcome = Extract<
  NftVerificationOutcome,
  { readonly status: 'resolved' }
>

export type NftCollectionVerifier = (
  childTokenId: string
) => Promise<NftVerificationOutcome>

export type NftVerificationService = {
  readonly verify: NftCollectionVerifier
  readonly invalidate: (childTokenId?: string) => void
}

type NftEvidenceReaderFactory = () => NftEvidenceChronikReader

const ERROR_OUTCOME: NftVerificationOutcome = Object.freeze({ status: 'error' })

// Two sequential Chronik reads should normally finish well inside this interactive bound.
export const NFT_VERIFICATION_TIMEOUT_MS = 10_000

function withVerificationTimeout(
  pipeline: Promise<NftVerificationOutcome>
): Promise<NftVerificationOutcome> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<NftVerificationOutcome>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(ERROR_OUTCOME), NFT_VERIFICATION_TIMEOUT_MS)
  })

  return Promise.race([pipeline, timeout]).finally(() => {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle)
    }
  })
}

export function createNftVerificationService(
  readerFactory: NftEvidenceReaderFactory
): NftVerificationService {
  const settled = new Map<string, ResolvedNftVerificationOutcome>()
  const inFlight = new Map<string, Promise<NftVerificationOutcome>>()
  const keyVersions = new Map<string, number>()
  let globalVersion = 0

  const verify: NftCollectionVerifier = (childTokenId) => {
    const cached = settled.get(childTokenId)
    if (cached !== undefined) {
      return Promise.resolve(cached)
    }

    const pending = inFlight.get(childTokenId)
    if (pending) {
      return pending
    }

    const requestGlobalVersion = globalVersion
    const requestKeyVersion = keyVersions.get(childTokenId) ?? 0
    const pipeline = Promise.resolve().then(async () => {
      let reader: NftEvidenceChronikReader | null = null
      const getReader = () => {
        reader ??= readerFactory()
        return reader
      }
      const evidence = await extractNftCollectionEvidence(childTokenId, {
        token: (tokenId) => getReader().token(tokenId),
        tx: (txid) => getReader().tx(txid)
      })
      const tier = classifyCollection(evidence)
      if (evidence.kind === 'unverified' && evidence.reason === 'malformed-evidence') {
        return ERROR_OUTCOME
      }
      return Object.freeze({ status: 'resolved', tier } as const)
    })
    const operation = withVerificationTimeout(pipeline)

    inFlight.set(childTokenId, operation)
    void operation.then(
      (outcome) => {
        if (inFlight.get(childTokenId) !== operation) {
          return
        }

        inFlight.delete(childTokenId)
        if (
          outcome.status === 'resolved' &&
          globalVersion === requestGlobalVersion &&
          (keyVersions.get(childTokenId) ?? 0) === requestKeyVersion
        ) {
          settled.set(childTokenId, outcome)
        }
      },
      () => {
        if (inFlight.get(childTokenId) === operation) {
          inFlight.delete(childTokenId)
        }
      }
    )

    return operation
  }

  const invalidate = (childTokenId?: string) => {
    if (typeof childTokenId === 'string') {
      settled.delete(childTokenId)
      inFlight.delete(childTokenId)
      keyVersions.set(childTokenId, (keyVersions.get(childTokenId) ?? 0) + 1)
      return
    }

    globalVersion += 1
    settled.clear()
    inFlight.clear()
    keyVersions.clear()
  }

  return Object.freeze({ verify, invalidate })
}

const productionNftVerificationService = createNftVerificationService(() => getChronik())

export const verifyNftCollection: NftCollectionVerifier = (childTokenId) =>
  productionNftVerificationService.verify(childTokenId)

export const invalidateNftVerification = (childTokenId?: string) =>
  productionNftVerificationService.invalidate(childTokenId)
