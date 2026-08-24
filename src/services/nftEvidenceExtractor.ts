import type { OnChainNftCollectionEvidence } from '../domain/nftCollections'

export interface NftEvidenceChronikReader {
  readonly token: (tokenId: string) => Promise<unknown>
  readonly tx: (txid: string) => Promise<unknown>
}

type UnverifiedReason = Extract<
  OnChainNftCollectionEvidence,
  { kind: 'unverified' }
>['reason']

type ExternalRecord = object

const CANONICAL_TOKEN_ID_PATTERN = /^[0-9a-f]{64}$/
const MALFORMED_PROPERTY = Symbol('malformed-property')
const NFT1_CHILD_TYPE = Object.freeze({
  protocol: 'SLP',
  type: 'SLP_TOKEN_TYPE_NFT1_CHILD',
  number: 65
})
const NFT1_GROUP_TYPE = Object.freeze({
  protocol: 'SLP',
  type: 'SLP_TOKEN_TYPE_NFT1_GROUP',
  number: 129
})

function unverified(reason: UnverifiedReason): OnChainNftCollectionEvidence {
  return { kind: 'unverified', reason }
}

function asExternalRecord(value: unknown): ExternalRecord | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return null
    }

    return value as ExternalRecord
  } catch {
    return null
  }
}

function readOwnDataProperty(
  record: ExternalRecord,
  property: PropertyKey
): unknown | typeof MALFORMED_PROPERTY {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, property)

    if (descriptor === undefined) {
      return undefined
    }

    return 'value' in descriptor ? descriptor.value : MALFORMED_PROPERTY
  } catch {
    return MALFORMED_PROPERTY
  }
}

function isCanonicalTokenId(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_TOKEN_ID_PATTERN.test(value)
}

function readTokenType(value: unknown):
  | {
      readonly protocol: string
      readonly type: string
      readonly number: number
    }
  | null {
  const record = asExternalRecord(value)
  if (record === null) {
    return null
  }

  const protocol = readOwnDataProperty(record, 'protocol')
  const type = readOwnDataProperty(record, 'type')
  const number = readOwnDataProperty(record, 'number')

  if (
    protocol === MALFORMED_PROPERTY ||
    type === MALFORMED_PROPERTY ||
    number === MALFORMED_PROPERTY ||
    typeof protocol !== 'string' ||
    typeof type !== 'string' ||
    typeof number !== 'number' ||
    !Number.isInteger(number)
  ) {
    return null
  }

  return { protocol, type, number }
}

function isExactTokenType(
  actual: ReturnType<typeof readTokenType>,
  expected: typeof NFT1_CHILD_TYPE | typeof NFT1_GROUP_TYPE
): boolean {
  return (
    actual !== null &&
    actual.protocol === expected.protocol &&
    actual.type === expected.type &&
    actual.number === expected.number
  )
}

function isUnambiguousChronikNotFound(error: unknown, tokenId: string): boolean {
  try {
    if (!(error instanceof Error)) {
      return false
    }

    const messageDescriptor = Object.getOwnPropertyDescriptor(error, 'message')
    if (
      messageDescriptor === undefined ||
      !('value' in messageDescriptor) ||
      typeof messageDescriptor.value !== 'string'
    ) {
      return false
    }

    return (
      messageDescriptor.value ===
        `Failed getting /token/${tokenId}: 404: Token ${tokenId} not found in the index` ||
      messageDescriptor.value ===
        `Failed getting /tx/${tokenId}: 404: Transaction ${tokenId} not found in the index`
    )
  } catch {
    return false
  }
}

export async function extractNftCollectionEvidence(
  childTokenId: string,
  chronik: NftEvidenceChronikReader
): Promise<OnChainNftCollectionEvidence> {
  if (!isCanonicalTokenId(childTokenId)) {
    return unverified('malformed-evidence')
  }

  try {
    const tokenInfo = asExternalRecord(await chronik.token(childTokenId))
    if (tokenInfo === null) {
      return unverified('malformed-evidence')
    }

    const observedChildTokenId = readOwnDataProperty(tokenInfo, 'tokenId')
    const childTokenType = readTokenType(readOwnDataProperty(tokenInfo, 'tokenType'))

    if (
      observedChildTokenId === MALFORMED_PROPERTY ||
      !isCanonicalTokenId(observedChildTokenId) ||
      observedChildTokenId !== childTokenId ||
      childTokenType === null
    ) {
      return unverified('malformed-evidence')
    }

    if (!isExactTokenType(childTokenType, NFT1_CHILD_TYPE)) {
      return unverified('invalid-child-type')
    }

    const genesis = asExternalRecord(await chronik.tx(childTokenId))
    if (genesis === null) {
      return unverified('malformed-evidence')
    }

    const genesisTxid = readOwnDataProperty(genesis, 'txid')
    const inputs = readOwnDataProperty(genesis, 'inputs')
    if (
      genesisTxid === MALFORMED_PROPERTY ||
      genesisTxid !== childTokenId ||
      inputs === MALFORMED_PROPERTY ||
      !Array.isArray(inputs)
    ) {
      return unverified('malformed-evidence')
    }

    const firstInputValue = readOwnDataProperty(inputs, 0)
    if (firstInputValue === undefined) {
      return unverified('missing-group-input')
    }

    if (firstInputValue === MALFORMED_PROPERTY) {
      return unverified('malformed-evidence')
    }

    const firstInput = asExternalRecord(firstInputValue)
    if (firstInput === null) {
      return unverified('malformed-evidence')
    }

    const groupTokenValue = readOwnDataProperty(firstInput, 'token')
    if (groupTokenValue === undefined || groupTokenValue === null) {
      return unverified('missing-group-input')
    }

    if (groupTokenValue === MALFORMED_PROPERTY) {
      return unverified('malformed-evidence')
    }

    const groupToken = asExternalRecord(groupTokenValue)
    if (groupToken === null) {
      return unverified('malformed-evidence')
    }

    const groupTokenType = readTokenType(readOwnDataProperty(groupToken, 'tokenType'))
    if (groupTokenType === null) {
      return unverified('malformed-evidence')
    }

    if (!isExactTokenType(groupTokenType, NFT1_GROUP_TYPE)) {
      return unverified('invalid-group-type')
    }

    const groupTokenId = readOwnDataProperty(groupToken, 'tokenId')
    if (groupTokenId === MALFORMED_PROPERTY || !isCanonicalTokenId(groupTokenId)) {
      return unverified('malformed-evidence')
    }

    return {
      kind: 'verified-nft1-child-genesis',
      childTokenId,
      groupTokenId,
      childTokenType: 65,
      groupTokenType: 129
    }
  } catch (error) {
    return unverified(
      isUnambiguousChronikNotFound(error, childTokenId)
        ? 'missing-genesis'
        : 'malformed-evidence'
    )
  }
}
