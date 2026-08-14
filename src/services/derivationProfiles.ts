import { Address, HdNode, fromHex, mnemonicToSeed, shaRmd160, toHex } from 'ecash-lib'

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
export const DERIVATION_PROFILE_STORAGE_KEY = 'xoloswallet_derivation_profile_v1'
export const DERIVATION_PROFILE_STORAGE_VERSION = 1 as const

export type StoredDerivationProfileMetadata = Readonly<{
  version: typeof DERIVATION_PROFILE_STORAGE_VERSION
  derivationProfile: DerivationProfileId
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

/** Private material derived only at an explicit signing boundary. */
export type SigningDerivationMetadata = PublicDerivationMetadata & Readonly<{
  privateKey: Uint8Array
}>

/**
 * The public half of a hardened BIP44 account node. ecash-lib currently does
 * not expose xpub serialization helpers, so this is the exact extended-public
 * tuple required to reconstruct the same watch-only HdNode without a seckey.
 */
export type AccountXpub = Readonly<{
  profileId: DerivationProfileId
  account: 0
  basePath: string
  publicKeyHex: string
  chainCodeHex: string
  depth: number
  index: number
  parentFingerprint: number
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

/**
 * Cross the private derivation boundary once for a profile and retain only the
 * hardened account node's public material. The seed buffer is wiped before
 * this function returns; root/account private-capable nodes remain local.
 */
export function deriveAccountXpub(
  mnemonic: string,
  profileId: DerivationProfileId
): AccountXpub {
  const profile = getDerivationProfile(profileId)
  const seed = mnemonicToSeed(mnemonic.trim(), '')
  try {
    const accountNode = HdNode.fromSeed(seed).derivePath(profile.basePath)
    return Object.freeze({
      profileId,
      account: profile.account,
      basePath: profile.basePath,
      publicKeyHex: toHex(accountNode.pubkey()),
      chainCodeHex: toHex(accountNode.chainCode()),
      depth: accountNode.depth(),
      index: accountNode.index(),
      parentFingerprint: accountNode.parentFingerprint()
    })
  } finally {
    seed.fill(0)
  }
}

/** Reconstruct a watch-only account node from the public account snapshot. */
export function accountXpubToWatchOnlyNode(accountXpub: AccountXpub): HdNode {
  return new HdNode({
    seckey: undefined,
    pubkey: fromHex(accountXpub.publicKeyHex),
    chainCode: fromHex(accountXpub.chainCodeHex),
    depth: accountXpub.depth,
    index: accountXpub.index,
    parentFingerprint: accountXpub.parentFingerprint
  })
}

/** Derive discovery/preview metadata exclusively from a watch-only account. */
export function deriveWatchOnlyMetadata(
  accountXpub: AccountXpub,
  branch: DerivationBranch,
  index: number
): PublicDerivationMetadata {
  const hdPath = getDerivationPath(accountXpub.profileId, branch, index)
  const branchIndex = branch === 'receive' ? 0 : 1
  const node = accountXpubToWatchOnlyNode(accountXpub).derive(branchIndex).derive(index)
  if (node.seckey() !== undefined) {
    throw new Error('La derivación pública produjo inesperadamente una llave privada.')
  }
  const publicKey = node.pubkey()
  const hash160 = shaRmd160(publicKey)
  return Object.freeze({
    profileId: accountXpub.profileId,
    account: accountXpub.account,
    branch,
    index,
    hdPath,
    address: Address.p2pkh(hash160).toString(),
    publicKeyHex: toHex(publicKey),
    hash160Hex: toHex(hash160)
  })
}

/**
 * Re-enter the private boundary for one exact input path. Callers must invoke
 * this only after any preview/fresh-state checks have completed.
 */
export function deriveSigningMetadata(
  mnemonic: string,
  profileId: DerivationProfileId,
  branch: DerivationBranch,
  index: number
): SigningDerivationMetadata {
  const hdPath = getDerivationPath(profileId, branch, index)
  const seed = mnemonicToSeed(mnemonic.trim(), '')
  try {
    const node = HdNode.fromSeed(seed).derivePath(hdPath)
    const privateKey = node.seckey()
    if (privateKey === undefined) {
      throw new Error('La ruta de firma no produjo una llave privada.')
    }
    const publicKey = node.pubkey()
    const hash160 = shaRmd160(publicKey)
    return {
      profileId,
      account: getDerivationProfile(profileId).account,
      branch,
      index,
      hdPath,
      address: Address.p2pkh(hash160).toString(),
      publicKeyHex: toHex(publicKey),
      hash160Hex: toHex(hash160),
      privateKey
    }
  } finally {
    seed.fill(0)
  }
}
