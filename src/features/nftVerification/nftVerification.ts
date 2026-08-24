import { classifyCollection, type CollectionTier } from '../../domain/nftCollections'
import { getChronik } from '../../services/ChronikClient'
import {
  extractNftCollectionEvidence,
  type NftEvidenceChronikReader
} from '../../services/nftEvidenceExtractor'

export type NftVerificationOutcome =
  | { readonly status: 'resolved'; readonly tier: CollectionTier }
  | { readonly status: 'error' }

export type NftCollectionVerifier = (
  childTokenId: string
) => Promise<NftVerificationOutcome>

export type NftVerificationService = {
  readonly verify: NftCollectionVerifier
  readonly invalidate: (childTokenId?: string) => void
}

type NftEvidenceReaderFactory = () => NftEvidenceChronikReader

const ERROR_OUTCOME: NftVerificationOutcome = Object.freeze({ status: 'error' })

export function createNftVerificationService(
  readerFactory: NftEvidenceReaderFactory
): NftVerificationService {
  const settled = new Map<string, NftVerificationOutcome>()
  const inFlight = new Map<string, Promise<NftVerificationOutcome>>()
  const keyVersions = new Map<string, number>()
  let globalVersion = 0

  const verify: NftCollectionVerifier = (childTokenId) => {
    if (settled.has(childTokenId)) {
      return Promise.resolve(settled.get(childTokenId) ?? ERROR_OUTCOME)
    }

    const pending = inFlight.get(childTokenId)
    if (pending) {
      return pending
    }

    const requestGlobalVersion = globalVersion
    const requestKeyVersion = keyVersions.get(childTokenId) ?? 0
    const operation = Promise.resolve().then(async () => {
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

    inFlight.set(childTokenId, operation)
    void operation.then(
      (tier) => {
        if (inFlight.get(childTokenId) === operation) {
          inFlight.delete(childTokenId)
        }
        if (
          globalVersion === requestGlobalVersion &&
          (keyVersions.get(childTokenId) ?? 0) === requestKeyVersion
        ) {
          settled.set(childTokenId, tier)
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
