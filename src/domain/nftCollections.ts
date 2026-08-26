export type CollectionId = 'official' | 'community'

export type CollectionTier = 'official' | 'community' | 'unknown'

export type RegisteredCollection = {
  readonly id: CollectionId
  readonly tier: Exclude<CollectionTier, 'unknown'>
  readonly parentTokenId: string | null
}

const CANONICAL_TOKEN_ID_PATTERN = /^[0-9a-f]{64}$/

export const NFT_COLLECTION_TRUST_REGISTRY_VERSION = 2 as const

export const NFT_COLLECTION_TRUST_REGISTRY = Object.freeze({
  official: Object.freeze({
    id: 'official',
    tier: 'official',
    parentTokenId: 'bf8e0b5cd60fe4d6354c662b28542e0f3c3d69941eb039426d65bcdb7fe9f48c'
  }),
  community: Object.freeze({
    id: 'community',
    tier: 'community',
    parentTokenId: 'd6ff881413733a1a6407fa5e1e86537e5fc9f48246bae89b732ca7044993e57a'
  })
}) satisfies Readonly<Record<CollectionId, RegisteredCollection>>

export function isCollectionId(value: unknown): value is CollectionId {
  return value === 'official' || value === 'community'
}

export function resolveRegisteredNftCollection(collectionId: CollectionId): RegisteredCollection {
  if (!isCollectionId(collectionId)) {
    throw new Error('Colección NFT no registrada.')
  }

  const collection = NFT_COLLECTION_TRUST_REGISTRY[collectionId]
  if (
    collection.parentTokenId === null ||
    !CANONICAL_TOKEN_ID_PATTERN.test(collection.parentTokenId)
  ) {
    throw new Error('La colección NFT no tiene un Parent canónico activo.')
  }

  return collection
}

export function resolveNftCollectionParentTokenId(collectionId: CollectionId): string {
  const parentTokenId = resolveRegisteredNftCollection(collectionId).parentTokenId
  if (parentTokenId === null) {
    throw new Error('La colección NFT no tiene un Parent canónico activo.')
  }
  return parentTokenId
}

export type OnChainNftCollectionEvidence =
  | {
      readonly kind: 'verified-nft1-child-genesis'
      readonly childTokenId: string
      readonly groupTokenId: string
      readonly childTokenType: 65
      readonly groupTokenType: 129
    }
  | {
      readonly kind: 'unverified'
      readonly reason:
        | 'missing-genesis'
        | 'invalid-child-type'
        | 'missing-group-input'
        | 'invalid-group-type'
        | 'malformed-evidence'
    }

export function classifyCollection(evidence: OnChainNftCollectionEvidence): CollectionTier {
  try {
    if (
      evidence.kind !== 'verified-nft1-child-genesis' ||
      evidence.childTokenType !== 65 ||
      evidence.groupTokenType !== 129 ||
      typeof evidence.childTokenId !== 'string' ||
      typeof evidence.groupTokenId !== 'string' ||
      !CANONICAL_TOKEN_ID_PATTERN.test(evidence.childTokenId) ||
      !CANONICAL_TOKEN_ID_PATTERN.test(evidence.groupTokenId)
    ) {
      return 'unknown'
    }

    for (const collection of Object.values(NFT_COLLECTION_TRUST_REGISTRY)) {
      if (collection.parentTokenId !== null && collection.parentTokenId === evidence.groupTokenId) {
        return collection.tier
      }
    }
  } catch {
    return 'unknown'
  }

  return 'unknown'
}

export type NftCollectionMetadataAttribute = {
  readonly trait_type: string
  readonly value: string | number | boolean
}

export type NftCollectionMetadataParams = {
  readonly collectionId: CollectionId
  readonly name: string
  readonly description: string
  readonly image: string
  readonly externalUrl?: string
  readonly attributes?: readonly NftCollectionMetadataAttribute[]
}

export type NftCollectionMetadata = {
  readonly schema: 'tonalli-nft-collection'
  readonly schema_version: 1
  readonly name: string
  readonly description: string
  readonly image: string
  readonly external_url?: string
  readonly attributes: readonly NftCollectionMetadataAttribute[]
  readonly collection: {
    readonly id: CollectionId
    readonly parentTokenId: string | null
    readonly registryVersion: typeof NFT_COLLECTION_TRUST_REGISTRY_VERSION
  }
}

export function buildNftCollectionMetadata({
  collectionId,
  name,
  description,
  image,
  externalUrl,
  attributes = []
}: NftCollectionMetadataParams): NftCollectionMetadata {
  const collection = NFT_COLLECTION_TRUST_REGISTRY[collectionId]

  return {
    schema: 'tonalli-nft-collection',
    schema_version: 1,
    name,
    description,
    image,
    ...(externalUrl === undefined ? {} : { external_url: externalUrl }),
    attributes: attributes.map((attribute) => ({ ...attribute })),
    collection: {
      id: collection.id,
      parentTokenId: collection.parentTokenId,
      registryVersion: NFT_COLLECTION_TRUST_REGISTRY_VERSION
    }
  }
}
