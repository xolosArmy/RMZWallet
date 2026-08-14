import { Address, HdNode, fromHex, mnemonicToSeed, shaRmd160, toHex } from 'ecash-lib'
import {
  TONALLI_LEGACY_899_BASE_PATH,
  deriveLegacy899AccountPublicState,
  deriveLegacy899PublicMetadata,
  deriveLegacy899SigningKey
} from './legacy899Compatibility'

export const TONALLI_LEGACY_PROFILE_ID = 'tonalli-legacy-899' as const
export const ECASH_STANDARD_899_PROFILE_ID = 'ecash-standard-899' as const
export const ECASH_STANDARD_PROFILE_ID = 'ecash-standard-1899' as const

export const TONALLI_LEGACY_DERIVATION_ENGINE =
  'minimal-xec-wallet-2.0.2-compat' as const
export const ECASH_LIB_DERIVATION_ENGINE = 'ecash-lib-bip32' as const

export type DerivationEngineId =
  | typeof TONALLI_LEGACY_DERIVATION_ENGINE
  | typeof ECASH_LIB_DERIVATION_ENGINE

export type DerivationProfileId =
  | typeof TONALLI_LEGACY_PROFILE_ID
  | typeof ECASH_STANDARD_899_PROFILE_ID
  | typeof ECASH_STANDARD_PROFILE_ID

export type DerivationBranch = 'receive' | 'change'

export type DerivationProfile = Readonly<{
  id: DerivationProfileId
  coinType: 899 | 1899
  engine: DerivationEngineId
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
      engine: TONALLI_LEGACY_DERIVATION_ENGINE,
      account: 0,
      basePath: TONALLI_LEGACY_899_BASE_PATH,
      label: 'Tonalli Legacy',
      compatibility: 'Semántica criptográfica histórica de minimal-xec-wallet 2.0.2'
    }),
    [ECASH_STANDARD_899_PROFILE_ID]: Object.freeze({
      id: ECASH_STANDARD_899_PROFILE_ID,
      coinType: 899,
      engine: ECASH_LIB_DERIVATION_ENGINE,
      account: 0,
      basePath: "m/44'/899'/0'",
      label: 'eCash Standard 899 Recovery',
      compatibility: 'Recuperación de la ventana transitoria BIP32 estándar con coin type 899'
    }),
    [ECASH_STANDARD_PROFILE_ID]: Object.freeze({
      id: ECASH_STANDARD_PROFILE_ID,
      coinType: 1899,
      engine: ECASH_LIB_DERIVATION_ENGINE,
      account: 0,
      basePath: "m/44'/1899'/0'",
      label: 'eCash / Cashtab',
      compatibility: 'Compatible con eCash, Cashtab y pruebas posteriores con Firma Wallet'
    })
  })

export const DERIVATION_PROFILE_IDS = Object.freeze([
  TONALLI_LEGACY_PROFILE_ID,
  ECASH_STANDARD_899_PROFILE_ID,
  ECASH_STANDARD_PROFILE_ID
] as const)

export const DEFAULT_NEW_WALLET_PROFILE_ID = ECASH_STANDARD_PROFILE_ID
export const DERIVATION_PROFILE_STORAGE_KEY = 'xoloswallet_derivation_profile_v1'
export const DERIVATION_PROFILE_STORAGE_VERSION = 2 as const

export type StoredDerivationProfileMetadata = Readonly<{
  version: typeof DERIVATION_PROFILE_STORAGE_VERSION
  derivationProfile: DerivationProfileId
  engine: DerivationEngineId
}>

export type PublicDerivationMetadata = Readonly<{
  profileId: DerivationProfileId
  engine: DerivationEngineId
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
 * Public account tuple retained after the selected engine's hardened account
 * boundary. Standard engines reconstruct a watch-only HdNode from it; the
 * historical compatibility engine consumes it with its isolated IL algorithm.
 */
export type AccountPublicState = Readonly<{
  profileId: DerivationProfileId
  engine: DerivationEngineId
  account: 0
  basePath: string
  publicKeyHex: string
  chainCodeHex: string
  depth: number
  index: number
  parentFingerprint: number
}>

/** @deprecated Prefer AccountPublicState: legacy compatibility is not BIP32. */
export type AccountXpub = AccountPublicState

export function isDerivationProfileId(value: unknown): value is DerivationProfileId {
  return value === TONALLI_LEGACY_PROFILE_ID ||
    value === ECASH_STANDARD_899_PROFILE_ID ||
    value === ECASH_STANDARD_PROFILE_ID
}

export function getDerivationProfile(profileId: DerivationProfileId): DerivationProfile {
  return DERIVATION_PROFILES[profileId]
}

const assertAccountStateMatchesProfile = (account: AccountPublicState) => {
  const profile = getDerivationProfile(account.profileId)
  if (
    account.engine !== profile.engine ||
    account.account !== profile.account ||
    account.basePath !== profile.basePath
  ) {
    throw new Error('El estado público de cuenta no corresponde al perfil y engine declarados.')
  }
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
  const profile = getDerivationProfile(profileId)
  return Object.freeze({
    version: DERIVATION_PROFILE_STORAGE_VERSION,
    derivationProfile: profileId,
    engine: profile.engine
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
    const candidate = parsed as {
      version?: unknown
      derivationProfile?: unknown
      engine?: unknown
    }
    if (
      candidate.version !== DERIVATION_PROFILE_STORAGE_VERSION ||
      !isDerivationProfileId(candidate.derivationProfile) ||
      candidate.engine !== getDerivationProfile(candidate.derivationProfile).engine
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
export function deriveAccountPublicState(
  mnemonic: string,
  profileId: DerivationProfileId
): AccountPublicState {
  const profile = getDerivationProfile(profileId)
  if (profile.engine === TONALLI_LEGACY_DERIVATION_ENGINE) {
    const account = deriveLegacy899AccountPublicState(mnemonic)
    return Object.freeze({
      profileId,
      engine: profile.engine,
      account: profile.account,
      basePath: profile.basePath,
      ...account
    })
  }
  const seed = mnemonicToSeed(mnemonic.trim(), '')
  try {
    const accountNode = HdNode.fromSeed(seed).derivePath(profile.basePath)
    return Object.freeze({
      profileId,
      engine: profile.engine,
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

/** @deprecated Prefer deriveAccountPublicState. */
export const deriveAccountXpub = deriveAccountPublicState

/** Reconstruct a watch-only account node from the public account snapshot. */
export function accountPublicStateToWatchOnlyNode(account: AccountPublicState): HdNode {
  assertAccountStateMatchesProfile(account)
  if (account.engine !== ECASH_LIB_DERIVATION_ENGINE) {
    throw new Error('El engine Tonalli Legacy no es un xpub BIP32 watch-only.')
  }
  return new HdNode({
    seckey: undefined,
    pubkey: fromHex(account.publicKeyHex),
    chainCode: fromHex(account.chainCodeHex),
    depth: account.depth,
    index: account.index,
    parentFingerprint: account.parentFingerprint
  })
}

/** @deprecated Prefer accountPublicStateToWatchOnlyNode. */
export const accountXpubToWatchOnlyNode = accountPublicStateToWatchOnlyNode

/**
 * Derive public discovery/preview metadata from the selected engine. Standard
 * profiles remain strictly watch-only. Legacy compatibility necessarily
 * materializes and wipes historical IL child secrets inside its isolated engine.
 */
export function derivePublicMetadata(
  account: AccountPublicState,
  branch: DerivationBranch,
  index: number
): PublicDerivationMetadata {
  assertAccountStateMatchesProfile(account)
  const hdPath = getDerivationPath(account.profileId, branch, index)
  if (account.engine === TONALLI_LEGACY_DERIVATION_ENGINE) {
    const derived = deriveLegacy899PublicMetadata(account, branch, index)
    return Object.freeze({
      profileId: account.profileId,
      engine: account.engine,
      account: account.account,
      branch,
      index,
      hdPath,
      ...derived
    })
  }
  const branchIndex = branch === 'receive' ? 0 : 1
  const node = accountPublicStateToWatchOnlyNode(account).derive(branchIndex).derive(index)
  if (node.seckey() !== undefined) {
    throw new Error('La derivación pública produjo inesperadamente una llave privada.')
  }
  const publicKey = node.pubkey()
  const hash160 = shaRmd160(publicKey)
  return Object.freeze({
    profileId: account.profileId,
    engine: account.engine,
    account: account.account,
    branch,
    index,
    hdPath,
    address: Address.p2pkh(hash160).toString(),
    publicKeyHex: toHex(publicKey),
    hash160Hex: toHex(hash160)
  })
}

/** @deprecated Prefer derivePublicMetadata. */
export const deriveWatchOnlyMetadata = derivePublicMetadata

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
  const profile = getDerivationProfile(profileId)
  if (profile.engine === TONALLI_LEGACY_DERIVATION_ENGINE) {
    const derived = deriveLegacy899SigningKey(mnemonic, branch, index)
    return Object.freeze({
      profileId,
      engine: profile.engine,
      account: profile.account,
      branch,
      index,
      hdPath,
      ...derived
    })
  }
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
      engine: profile.engine,
      account: profile.account,
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
