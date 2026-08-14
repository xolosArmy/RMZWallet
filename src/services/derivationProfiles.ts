import { Address, HdNode, mnemonicToSeed, shaRmd160, toHex } from 'ecash-lib'

export const TONALLI_LEGACY_PROFILE_ID = 'tonalli-legacy-899' as const
export const ECASH_STANDARD_PROFILE_ID = 'ecash-standard-1899' as const

export type DerivationProfileId =
  | typeof TONALLI_LEGACY_PROFILE_ID
  | typeof ECASH_STANDARD_PROFILE_ID

export type DerivationBranch = 'receive' | 'change'

export type DerivationProfile = Readonly<{
  id: DerivationProfileId
  coinType: 899 | 1899
  account: 0
  basePath: string
  label: string
  compatibility: string
}>

export const DERIVATION_PROFILES: Readonly<Record<DerivationProfileId, DerivationProfile>> =
  Object.freeze({
    [TONALLI_LEGACY_PROFILE_ID]: Object.freeze({
      id: TONALLI_LEGACY_PROFILE_ID,
      coinType: 899,
      account: 0,
      basePath: "m/44'/899'/0'",
      label: 'Tonalli Legacy',
      compatibility: 'Wallets Tonalli creadas antes de la compatibilidad BIP44 dual'
    }),
    [ECASH_STANDARD_PROFILE_ID]: Object.freeze({
      id: ECASH_STANDARD_PROFILE_ID,
      coinType: 1899,
      account: 0,
      basePath: "m/44'/1899'/0'",
      label: 'eCash / Cashtab',
      compatibility: 'Compatible con eCash, Cashtab y pruebas posteriores con Firma Wallet'
    })
  })

export const DERIVATION_PROFILE_IDS = Object.freeze([
  TONALLI_LEGACY_PROFILE_ID,
  ECASH_STANDARD_PROFILE_ID
] as const)

export const DEFAULT_NEW_WALLET_PROFILE_ID = ECASH_STANDARD_PROFILE_ID
export const LEGACY_WALLET_MIGRATION_PROFILE_ID = TONALLI_LEGACY_PROFILE_ID
export const DERIVATION_PROFILE_STORAGE_KEY = 'xoloswallet_derivation_profile_v1'
export const DERIVATION_PROFILE_STORAGE_VERSION = 1 as const

export type StoredDerivationProfileMetadata = Readonly<{
  version: typeof DERIVATION_PROFILE_STORAGE_VERSION
  derivationProfile: DerivationProfileId
}>

export type StoredDerivationProfileResolution = Readonly<{
  metadata: StoredDerivationProfileMetadata
  migrated: boolean
}>

export type PublicDerivationMetadata = Readonly<{
  profileId: DerivationProfileId
  account: 0
  branch: DerivationBranch
  index: number
  hdPath: string
  address: string
  publicKeyHex: string
  hash160Hex: string
}>

export function isDerivationProfileId(value: unknown): value is DerivationProfileId {
  return value === TONALLI_LEGACY_PROFILE_ID || value === ECASH_STANDARD_PROFILE_ID
}

export function getDerivationProfile(profileId: DerivationProfileId): DerivationProfile {
  return DERIVATION_PROFILES[profileId]
}

export function getDerivationPath(
  profileId: DerivationProfileId,
  branch: DerivationBranch,
  index: number
): string {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error('El índice HD debe ser un entero seguro no negativo.')
  }
  const branchIndex = branch === 'receive' ? 0 : 1
  return `${getDerivationProfile(profileId).basePath}/${branchIndex}/${index}`
}

export function createStoredDerivationProfileMetadata(
  profileId: DerivationProfileId
): StoredDerivationProfileMetadata {
  return Object.freeze({
    version: DERIVATION_PROFILE_STORAGE_VERSION,
    derivationProfile: profileId
  })
}

export function serializeStoredDerivationProfileMetadata(profileId: DerivationProfileId): string {
  return JSON.stringify(createStoredDerivationProfileMetadata(profileId))
}

export function parseStoredDerivationProfileMetadata(
  raw: string | null | undefined
): StoredDerivationProfileMetadata | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return null
    const candidate = parsed as { version?: unknown; derivationProfile?: unknown }
    if (
      candidate.version !== DERIVATION_PROFILE_STORAGE_VERSION ||
      !isDerivationProfileId(candidate.derivationProfile)
    ) {
      return null
    }
    return createStoredDerivationProfileMetadata(candidate.derivationProfile)
  } catch {
    return null
  }
}

export function resolveStoredDerivationProfile(
  raw: string | null | undefined,
  hasStoredLegacyWallet: boolean
): StoredDerivationProfileResolution {
  const parsed = parseStoredDerivationProfileMetadata(raw)
  if (parsed) return Object.freeze({ metadata: parsed, migrated: false })

  const profileId = hasStoredLegacyWallet
    ? LEGACY_WALLET_MIGRATION_PROFILE_ID
    : DEFAULT_NEW_WALLET_PROFILE_ID
  return Object.freeze({
    metadata: createStoredDerivationProfileMetadata(profileId),
    migrated: hasStoredLegacyWallet
  })
}

/**
 * Derive only the public metadata required for discovery and previews.
 * The hardened BIP44 path is evaluated from the mnemonic, but this boundary
 * never extracts or returns a secret key or signatory.
 */
export function derivePublicMetadata(
  mnemonic: string,
  profileId: DerivationProfileId,
  branch: DerivationBranch,
  index: number
): PublicDerivationMetadata {
  const hdPath = getDerivationPath(profileId, branch, index)
  const root = HdNode.fromSeed(mnemonicToSeed(mnemonic.trim(), ''))
  const node = root.derivePath(hdPath)
  const publicKey = node.pubkey()
  const hash160 = shaRmd160(publicKey)
  return Object.freeze({
    profileId,
    account: 0,
    branch,
    index,
    hdPath,
    address: Address.p2pkh(hash160).toString(),
    publicKeyHex: toHex(publicKey),
    hash160Hex: toHex(hash160)
  })
}
