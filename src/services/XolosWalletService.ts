import * as MinimalXecWalletModule from 'minimal-xec-wallet'
import { generateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import {
  ALL_BIP143,
  Address,
  Ecc,
  P2PKHSignatory,
  Script,
  TxBuilder,
  fromHex,
  shaRmd160,
  signMsg,
  toHex
} from 'ecash-lib'
import { AgoraOneshotAdSignatory } from 'ecash-agora'
import type { ScriptUtxo } from 'chronik-client'
import type { AliasRegistrationData } from '@xolosarmy/tonalli-core'
import { RMZ_ETOKEN_ID } from '../config/rmzToken'
import { FIRMA_ALPHA, assertFirmaAlphaTokenInfo } from '../config/firmaAlpha'
import {
  FEE_RATE_SATS_PER_BYTE,
  TONALLI_SERVICE_FEE_SATS,
  XEC_DUST_SATS,
  XEC_TONALLI_TREASURY_ADDRESS
} from '../config/xecFees'
import { getChronik } from './ChronikClient'
import { extractAliasFromOutputScript } from './aliasDiscovery'
import { decryptWithPassword, encryptWithPassword } from './crypto'
import type { DecryptPasswordResult } from './crypto'
import {
  QuickStartUnavailableError,
  assertQuickStartStorageAvailable,
  clearPendingIdentityRecord,
  clearQuickStartMnemonic,
  computeMnemonicCommitment,
  deletePendingIdentityRecordVerified,
  getPendingIdentityRecord,
  getQuickStartRecordStatus,
  hasQuickStartMnemonic,
  inspectPendingIdentityAuthority,
  loadQuickStartMetadata,
  loadQuickStartMnemonic,
  PENDING_IDENTITY_STATE,
  PENDING_IDENTITY_STORAGE_KEY,
  setPendingIdentityRecord,
  storeQuickStartMnemonic,
  withIdentityMutationLock,
  withQuickStartCreationLock
} from './quickStartStorage'
import type { PendingIdentityRecord, PendingIdentityState, QuickStartRecordStatus } from './quickStartStorage'
import { formatTokenAmount, parseTokenAmount } from '../utils/tokenFormat'
import { WALLET_LIFECYCLE } from '../domain/walletLifecycle'

function generateOwnerToken(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  const bytes = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

import type {
  MinimalXecWallet,
  MinimalXECWalletConstructor,
  SendETokenOutput,
  SendXecOutput,
  WalletInfo
} from '../types/wallet'
import {
  FIRMA_SEND_FEE_PER_KB,
  buildFirmaSendPlan,
  createSignedFirmaSendBuilder
} from './firmaAlphaSend'
import type {
  FirmaInputOwner,
  FirmaOwnedUtxo,
  FirmaSendPlan,
  FirmaSendPreview
} from './firmaAlphaSend'
import {
  DEFAULT_NEW_WALLET_PROFILE_ID,
  DERIVATION_PROFILE_STORAGE_KEY,
  ECASH_STANDARD_PROFILE_ID,
  TONALLI_LEGACY_PROFILE_ID,
  deriveAccountPublicState,
  derivePublicMetadata,
  deriveSigningMetadata,
  getDerivationPath,
  getDerivationProfile,
  isDerivationProfileId,
  parseStoredDerivationProfileMetadata,
  serializeStoredDerivationProfileMetadata
} from './derivationProfiles'
import type {
  AccountPublicState,
  DerivationProfile,
  DerivationProfileId,
  SigningDerivationMetadata
} from './derivationProfiles'
import {
  discoverDerivationProfile,
  resolveProfileForMissingMetadata,
  summarizeTokenUtxos
} from './dualDerivationDiscovery'
import type {
  DerivationDiscovery,
  DiscoveredTokenAsset
} from './dualDerivationDiscovery'
export type { FirmaInputOwner, FirmaOwnedUtxo } from './firmaAlphaSend'

// The package ships a UMD/CJS build without an ES default export; grab whatever
// is available (named export, default from CJS transform, or browser global).
const MinimalXECWallet = (() => {
  const moduleExports = MinimalXecWalletModule as unknown as {
    MinimalXECWallet?: MinimalXECWalletConstructor
    default?: MinimalXECWalletConstructor
  }

  if (moduleExports.MinimalXECWallet) return moduleExports.MinimalXECWallet
  if (moduleExports.default) return moduleExports.default
  if (typeof window !== 'undefined') {
    return (window as Window & { MinimalXecWallet?: MinimalXECWalletConstructor }).MinimalXecWallet
  }
  return undefined
})()

if (!MinimalXECWallet) {
  throw new Error('MinimalXECWallet constructor not found (module export mismatch)')
}
const MinimalXECWalletResolved = MinimalXECWallet as MinimalXECWalletConstructor

const CHRONIK_ENDPOINTS = [
  'https://chronik.e.cash',
  'https://chronik.xolosarmy.xyz'
]
const STORAGE_KEY_MNEMONIC = 'xoloswallet_encrypted_mnemonic'
const BACKUP_KEY = 'xoloswallet_backup_verified'
export type QuickStartRecoveryState = 'NORMAL_UNBACKED' | 'INTERRUPTED_BACKUP' | 'BACKUP_VERIFIED'
const STORAGE_KEY_GAP_LIMIT = 'xoloswallet_gap_limit'
const SCAN_CACHE_TTL_MS = 30000
const CHRONIK_CONCURRENCY_LIMIT = 4
const ALIAS_CHRONIK_VERIFY_ATTEMPTS = 20
const ALIAS_CHRONIK_VERIFY_DELAY_MS = 3000
// Burned BIP39 vector. MinimalXECWallet is instantiated only as a utility;
// the user's mnemonic is bound later to Tonalli's canonical derivation port.
const MINIMAL_WALLET_UTILITY_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

export const DEFAULT_GAP_LIMIT = 20
export const EXTENDED_GAP_LIMIT = 100

type AddressScan = {
  address: string
  utxos: ScriptUtxo[]
  hasHistory: boolean
}

type ScanCache = {
  profileId: DerivationProfileId
  gapLimit: number
  updatedAt: number
  receive: string[]
  change: string[]
  owners: FirmaInputOwner[]
  balances: WalletBalance
  tokenAssets: readonly DiscoveredTokenAsset[]
}

const parseGapLimit = (value: string | null | undefined) => {
  if (!value) return null
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return parsed
}

const clampGapLimit = (value: number) => Math.min(Math.max(value, 1), EXTENDED_GAP_LIMIT)

const delay = (ms: number) => new Promise((resolve) => {
  globalThis.setTimeout(resolve, ms)
})

export const WALLET_DERIVATION_PATH = getDerivationPath(TONALLI_LEGACY_PROFILE_ID, 'receive', 0)

export const getWalletReceivePath = (
  index: number,
  profileId: DerivationProfileId = TONALLI_LEGACY_PROFILE_ID
) => getDerivationPath(profileId, 'receive', index)

export const getWalletChangePath = (
  index: number,
  profileId: DerivationProfileId = TONALLI_LEGACY_PROFILE_ID
) => getDerivationPath(profileId, 'change', index)

const runWithConcurrency = async <T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> => {
  const results: R[] = []
  let index = 0

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index
      index += 1
      results[current] = await worker(items[current])
    }
  })

  await Promise.all(runners)
  return results
}

export interface WalletBalance {
  xec: bigint // pure, spendable XEC satoshis
  tokenUtxoSats: bigint
  tokenUtxoXecFormatted: string
  rmzAtoms: bigint
  rmzFormatted: string
  rmzDecimals: number
  firmaAtoms: bigint
  firmaFormatted: string
  firmaDecimals: number
  xecFormatted: string // XEC con 2 decimales
}

export const partitionWalletSats = (utxos: readonly ScriptUtxo[]) =>
  Object.freeze(utxos.reduce(
    (totals, utxo) => {
      if (utxo.token) totals.tokenUtxoSats += utxo.sats
      else totals.spendableXecSats += utxo.sats
      return totals
    },
    { spendableXecSats: 0n, tokenUtxoSats: 0n }
  ))

export type WalletRescanOptions = {
  gapLimit?: number
  startIndex?: number
  maxAddresses?: number
}

export type WalletRestoreResult = Readonly<{
  status: 'restored' | 'choice-required'
  detection: DerivationDiscovery
  selectedProfileId?: DerivationProfileId
  notice: string
}>

export type WalletLoadResult = Readonly<{
  status: 'loaded' | 'choice-required'
  detection?: DerivationDiscovery
  selectedProfileId?: DerivationProfileId
  notice: string
}>

export interface WalletKeyInfo {
  mnemonic: string | null
  xecAddress: string | null
  address: string | null
  publicKeyHex: string | null
}

export interface WalletSignatory {
  address: string
  publicKeyHex: string
  publicKey: Uint8Array
  signatory: ReturnType<typeof P2PKHSignatory>
}

export interface X402WalletAccount {
  address: string
  publicKey: string
}

const X402_PUBLIC_KEY_VALIDATION_TWEAKS = Object.freeze([
  fromHex(`${'00'.repeat(31)}01`),
  fromHex(`${'00'.repeat(31)}02`)
])

export const isCanonicalX402WalletAccount = (
  account: X402WalletAccount | null
): account is X402WalletAccount => {
  if (
    account === null ||
    account.address !== account.address.trim() ||
    account.address !== account.address.toLowerCase() ||
    !/^(02|03)[0-9a-f]{64}$/u.test(account.publicKey)
  ) {
    return false
  }

  try {
    const parsedAddress = Address.fromCashAddress(account.address)
    if (
      parsedAddress.encoding !== 'cashaddr' ||
      parsedAddress.prefix !== 'ecash' ||
      parsedAddress.type !== 'p2pkh'
    ) {
      return false
    }

    const publicKey = fromHex(account.publicKey)
    const ecc = new Ecc()
    const isOnCurve = X402_PUBLIC_KEY_VALIDATION_TWEAKS.some((tweak) => {
      try {
        return ecc.pubkeyAdd(publicKey, tweak).length === 33
      } catch {
        return false
      }
    })
    return isOnCurve && Address.p2pkh(shaRmd160(publicKey)).toString() === account.address
  } catch {
    return false
  }
}

export type X402StoredWalletActivationResult = Readonly<
  | {
    status: 'active'
    account: Readonly<X402WalletAccount>
  }
  | {
    status: 'choice-required'
  }
>

export class X402StoredWalletActivationError extends Error {
  readonly reason: 'unlock-failed' | 'activation-failed'

  constructor(reason: 'unlock-failed' | 'activation-failed') {
    super('X402_STORED_WALLET_ACTIVATION_FAILED')
    this.name = 'X402StoredWalletActivationError'
    this.reason = reason
  }
}

export interface X402AuthorizationSignature {
  signature: string
  publicKey: string
}

export type AliasRegistrationEstimate = {
  protocolFeeSats: number
  networkFeeSats: number
  totalCostSats: number
}

export type AliasRegistrationBroadcastResult = {
  txid: string
  status: 'broadcast_pending_index' | 'confirmed_by_chronik'
  message?: string
  rawTx: string
  debug: AliasRegistrationDebugInfo
}

export type AliasUtxoDebugInfo = {
  txid: string
  outIdx: number
  sats: string
}

export type AliasRegistrationUtxoSource = 'current_wallet_utxos' | 'reserved_pre_rmz_utxos'

export type AliasRegistrationDebugInfo = {
  reservedAliasUtxosBeforeRmzTx: AliasUtxoDebugInfo[]
  rmzTxid: string | null
  aliasSelectedUtxos: AliasUtxoDebugInfo[]
  excludedTxids: string[]
  usesRmzChangeOutput: boolean
  utxoSelectionSource: AliasRegistrationUtxoSource
}

export type AliasRegistrationRawTxDebug = {
  rawTxHex: string
  computedTxid: string
  containsAliasLokadPrefix: boolean
  selectedUtxos: AliasUtxoDebugInfo[]
  aliasSelectedUtxos: AliasUtxoDebugInfo[]
  reservedAliasUtxosBeforeRmzTx: AliasUtxoDebugInfo[]
  rmzTxid: string | null
  excludedTxids: string[]
  usesRmzChangeOutput: boolean
  utxoSelectionSource: AliasRegistrationUtxoSource
  outputs: Array<{
    index: number
    sats: string
    scriptHex: string
  }>
  protocolFeeAddress: string
  protocolFeeSats: number
}

type AliasTxPlan = {
  signedTx: ReturnType<TxBuilder['sign']>
  inputSats: bigint
  fixedOutputSats: bigint
  selectedUtxos: ScriptUtxo[]
  reservedAliasUtxosBeforeRmzTx: ScriptUtxo[]
  excludedTxids: string[]
  usesRmzChangeOutput: boolean
  utxoSelectionSource: AliasRegistrationUtxoSource
}

export type AliasReservedUtxo = ScriptUtxo

type CanonicalMnemonicDeriver = {
  deriveFromMnemonic: (mnemonic: string, hdPath?: string) => {
    address: string
    publicKey: string
    privateKey: string
  }
}

type MinimalWalletCompatibilitySurface = MinimalXecWallet & {
  walletInfo?: WalletInfo & { hdPath?: string }
  keyDerivation?: CanonicalMnemonicDeriver
  sendXecLib?: { keyDerivation?: CanonicalMnemonicDeriver }
  opReturn?: { keyDerivation?: CanonicalMnemonicDeriver }
  hybridTokens?: {
    slpHandler?: { keyDerivation?: CanonicalMnemonicDeriver }
    alpHandler?: { keyDerivation?: CanonicalMnemonicDeriver }
  }
}

const INDEPENDENT_ALIAS_UTXO_ERROR =
  'Not enough independent XEC UTXOs. Send a small amount of XEC to yourself, wait for it to appear, and try again.'
const RMZ_CHANGE_ALIAS_ABORT_ERROR = 'Alias transaction attempted to spend RMZ fee change output. Aborting.'

export class XolosWalletService {
  private static instance: XolosWalletService
  private wallet: MinimalXecWallet | null = null
  private isReady = false
  private encryptedMnemonic: string | null = null
  private decryptedMnemonic: string | null = null
  private scanCache: ScanCache | null = null
  private scanPromise: Promise<ScanCache> | null = null
  private scanPromiseGapLimit: number | null = null
  private hdAddressCache: FirmaInputOwner[] = []
  private activeProfileId: DerivationProfileId = DEFAULT_NEW_WALLET_PROFILE_ID
  private activeAccountState: AccountPublicState | null = null
  private walletActivationInFlight = false
  private rmzDecimals: number | null = null
  private rmzDecimalsPromise: Promise<number> | null = null
  private pendingAliasReservationExcludedTxids: string[] = []
  private pendingIdentityOwnerToken: string | null = null

  private constructor() {
    this.encryptedMnemonic = typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEY_MNEMONIC) : null
    if (typeof window !== 'undefined') {
      this.activeProfileId = parseStoredDerivationProfileMetadata(
        localStorage.getItem(DERIVATION_PROFILE_STORAGE_KEY)
      )?.derivationProfile ?? DEFAULT_NEW_WALLET_PROFILE_ID
    }
  }

  static getInstance(): XolosWalletService {
    if (!XolosWalletService.instance) {
      XolosWalletService.instance = new XolosWalletService()
    }
    return XolosWalletService.instance
  }

  private tryAcquireWalletActivation(): boolean {
    if (this.walletActivationInFlight) return false
    this.walletActivationInFlight = true
    return true
  }

  private releaseWalletActivation(): void {
    this.walletActivationInFlight = false
  }

  private buildWallet(profileId: DerivationProfileId) {
    this.activeProfileId = profileId
    this.isReady = false
    this.wallet = new MinimalXECWalletResolved(MINIMAL_WALLET_UTILITY_MNEMONIC, {
      hdPath: getDerivationPath(profileId, 'receive', 0),
      chronikUrls: CHRONIK_ENDPOINTS,
      enableDonations: false
    })
    this.scanCache = null
    this.scanPromise = null
    this.scanPromiseGapLimit = null
    this.hdAddressCache = []
    this.activeAccountState = null
    return this.wallet
  }

  private bindMinimalWalletToCanonicalProfile(mnemonic: string): void {
    const wallet = this.getWalletForBinding()
    const profileId = this.activeProfileId
    const canonicalOwner = this.deriveHdOwner('receive', 0)
    const expectedMnemonic = mnemonic.trim()
    const deriveFromMnemonic = (candidateMnemonic: string, hdPath = canonicalOwner.hdPath) => {
      if (candidateMnemonic.trim() !== expectedMnemonic) {
        throw new Error('La seed solicitada no corresponde a la wallet activa.')
      }
      const pathPrefix = `${getDerivationProfile(profileId).basePath}/`
      if (!hdPath.startsWith(pathPrefix)) {
        throw new Error('La ruta solicitada no pertenece al perfil activo.')
      }
      const pathParts = hdPath.slice(pathPrefix.length).split('/')
      const branch = pathParts[0] === '0'
        ? 'receive'
        : pathParts[0] === '1'
          ? 'change'
          : null
      const index = Number(pathParts[1])
      if (
        pathParts.length !== 2 ||
        branch === null ||
        !Number.isSafeInteger(index) ||
        index < 0 ||
        getDerivationPath(profileId, branch, index) !== hdPath
      ) {
        throw new Error('La ruta solicitada no es una ruta receive/change canónica.')
      }
      const derived = deriveSigningMetadata(expectedMnemonic, profileId, branch, index)
      return {
        address: derived.address,
        publicKey: derived.publicKeyHex,
        privateKey: toHex(derived.privateKey)
      }
    }
    if (!wallet.walletInfo) {
      throw new Error('MinimalXECWallet no expuso walletInfo para enlazar la identidad canónica.')
    }
    Object.assign(wallet.walletInfo, {
      mnemonic: expectedMnemonic,
      xecAddress: canonicalOwner.address,
      publicKey: canonicalOwner.publicKeyHex,
      privateKey: undefined,
      hdPath: canonicalOwner.hdPath
    })
    const derivationPorts = [
      wallet.keyDerivation,
      wallet.sendXecLib?.keyDerivation,
      wallet.opReturn?.keyDerivation,
      wallet.hybridTokens?.slpHandler?.keyDerivation,
      wallet.hybridTokens?.alpHandler?.keyDerivation
    ]
    if (derivationPorts.some((port) => port === undefined)) {
      throw new Error('MinimalXECWallet no expuso todos sus puertos internos de derivación.')
    }
    for (const port of derivationPorts) {
      (port as CanonicalMnemonicDeriver).deriveFromMnemonic = deriveFromMnemonic
    }
  }

  private getWalletForBinding(): MinimalWalletCompatibilitySurface {
    if (!this.wallet) throw new Error('La billetera no está disponible para enlazar su identidad.')
    return this.wallet as MinimalWalletCompatibilitySurface
  }

  private persistActiveProfile(): void {
    if (typeof window === 'undefined') return
    localStorage.setItem(
      DERIVATION_PROFILE_STORAGE_KEY,
      serializeStoredDerivationProfileMetadata(this.activeProfileId)
    )
  }

  private async activateMnemonic(
    mnemonic: string,
    profileId: DerivationProfileId,
    persistProfile = false
  ): Promise<void> {
    await this.activateMnemonicLocalIdentity(mnemonic, profileId)
    if (persistProfile) this.persistActiveProfile()
    const wallet = this.wallet as MinimalXecWallet | null
    if (!wallet) return
    void wallet.initialize().catch(() => {
      // Chronik/network failure must not block a recoverable local identity.
    })
  }

  private ensureReady() {
    if (!this.wallet || !this.isReady) {
      throw new Error('La billetera no está inicializada aún.')
    }
  }

  private getWallet(): MinimalXecWallet {
    this.ensureReady()
    return this.wallet as MinimalXecWallet
  }

  private getUtxoKey(utxo: ScriptUtxo) {
    return `${utxo.outpoint.txid}:${utxo.outpoint.outIdx}`
  }

  private utxosToDebug(utxos: ScriptUtxo[]): AliasUtxoDebugInfo[] {
    return utxos.map((utxo) => ({
      txid: utxo.outpoint.txid,
      outIdx: utxo.outpoint.outIdx,
      sats: utxo.sats.toString()
    }))
  }

  private getWalletUtxoStore(wallet: MinimalXecWallet): { xecUtxos?: ScriptUtxo[] } | null {
    const walletWithStore = wallet as MinimalXecWallet & {
      utxos?: {
        utxoStore?: {
          xecUtxos?: ScriptUtxo[]
        }
      }
    }
    return walletWithStore.utxos?.utxoStore ?? null
  }

  private async withTemporarilyExcludedWalletUtxos<T>(excludedUtxos: ScriptUtxo[], handler: () => Promise<T>): Promise<T> {
    if (excludedUtxos.length === 0) {
      return handler()
    }

    const wallet = this.getWallet()
    const utxoStore = this.getWalletUtxoStore(wallet)
    const originalUtxos = utxoStore?.xecUtxos
    if (!originalUtxos) {
      return handler()
    }

    const excludedKeys = new Set(excludedUtxos.map((utxo) => this.getUtxoKey(utxo)))
    utxoStore.xecUtxos = originalUtxos.filter((utxo) => !excludedKeys.has(this.getUtxoKey(utxo)))

    try {
      return await handler()
    } finally {
      utxoStore.xecUtxos = originalUtxos
    }
  }

  private getUtxoSatsNumber(utxo: ScriptUtxo) {
    return Number(utxo.sats)
  }

  private estimateTokenSendFeeSats(inputsCount: number, outputsCount: number) {
    const estimatedSizeBytes = inputsCount * 148 + outputsCount * 34 + 50
    return Math.ceil(estimatedSizeBytes * FEE_RATE_SATS_PER_BYTE)
  }

  private selectPureXecUtxosForSats(utxos: ScriptUtxo[], requiredSats: number, xecFromTokenUtxos: number) {
    if (xecFromTokenUtxos >= requiredSats) {
      return []
    }

    const additionalNeeded = requiredSats - xecFromTokenUtxos
    const sortedUtxos = utxos
      .slice()
      .sort((a, b) => this.getUtxoSatsNumber(b) - this.getUtxoSatsNumber(a))

    const selected: ScriptUtxo[] = []
    let selectedSats = 0

    for (const utxo of sortedUtxos) {
      selected.push(utxo)
      selectedSats += this.getUtxoSatsNumber(utxo)
      if (selectedSats >= additionalNeeded) {
        break
      }
    }

    if (selectedSats < additionalNeeded) {
      throw new Error(`Insufficient XEC for transaction fees. Need ${requiredSats} sats, have ${xecFromTokenUtxos} from tokens + ${selectedSats} from UTXOs`)
    }

    return selected
  }

  private async selectRmzServiceTransactionUtxos(amountAtoms: bigint): Promise<ScriptUtxo[]> {
    const address = this.getAddress()
    if (!address) {
      throw new Error('No se encontro la direccion de la billetera.')
    }

    const tokenInfo = await getChronik().token(RMZ_ETOKEN_ID)
    const utxoResponse = await getChronik().address(address).utxos()
    const rmzUtxos = utxoResponse.utxos
      .filter((utxo) =>
        utxo.token?.tokenId === RMZ_ETOKEN_ID &&
        utxo.token.tokenType?.protocol === 'ALP' &&
        !utxo.token.isMintBaton
      )
      .sort((a, b) => {
        const aAtoms = BigInt(a.token?.atoms ?? 0)
        const bAtoms = BigInt(b.token?.atoms ?? 0)
        return aAtoms > bAtoms ? -1 : aAtoms < bAtoms ? 1 : 0
      })

    const selectedTokenUtxos: ScriptUtxo[] = []
    let selectedAtoms = 0n
    for (const utxo of rmzUtxos) {
      selectedTokenUtxos.push(utxo)
      selectedAtoms += BigInt(utxo.token?.atoms ?? 0)
      if (selectedAtoms >= amountAtoms) {
        break
      }
    }

    if (selectedAtoms < amountAtoms) {
      const decimals = tokenInfo?.genesisInfo?.decimals ?? 0
      throw new Error(
        `No hay suficientes RMZ. Need: ${formatTokenAmount(amountAtoms, decimals)} RMZ, Available: ${formatTokenAmount(selectedAtoms, decimals)} RMZ`
      )
    }

    const pureXecUtxos = utxoResponse.utxos.filter((utxo) => !utxo.token)
    const tokenChangeAmount = selectedAtoms - amountAtoms
    const dustOutputsNeeded = 1 + (tokenChangeAmount > 0n ? 1 : 0)
    const dustRequirement = dustOutputsNeeded * XEC_DUST_SATS
    const baseInputs = selectedTokenUtxos.length
    const baseOutputs = 1 + 1 + (tokenChangeAmount > 0n ? 1 : 0)

    let estimatedFee = this.estimateTokenSendFeeSats(baseInputs, baseOutputs)
    let totalXecRequired = dustRequirement + estimatedFee
    let selectedFeeUtxos = this.selectPureXecUtxosForSats(
      pureXecUtxos,
      totalXecRequired,
      selectedTokenUtxos.reduce((sum, utxo) => sum + this.getUtxoSatsNumber(utxo), 0)
    )

    if (selectedFeeUtxos.length > 0) {
      estimatedFee = this.estimateTokenSendFeeSats(baseInputs + selectedFeeUtxos.length, baseOutputs)
      const nextTotalXecRequired = dustRequirement + estimatedFee
      if (nextTotalXecRequired > totalXecRequired) {
        totalXecRequired = nextTotalXecRequired
        selectedFeeUtxos = this.selectPureXecUtxosForSats(
          pureXecUtxos,
          totalXecRequired,
          selectedTokenUtxos.reduce((sum, utxo) => sum + this.getUtxoSatsNumber(utxo), 0)
        )
      }
    }

    return [...selectedTokenUtxos, ...selectedFeeUtxos]
  }

  async createNewWallet(password?: string): Promise<string> {
    return withQuickStartCreationLock(async () => {
      if (this.hasBackedWalletCiphertextOnDevice()) {
        throw new Error('BACKED_WALLET_EXISTS')
      }
      if (await hasQuickStartMnemonic()) {
        throw new Error('QUICK_START_RECORD_EXISTS')
      }
      const auth = inspectPendingIdentityAuthority()
      if (auth.status === PENDING_IDENTITY_STATE.STORAGE_UNAVAILABLE) {
        throw new Error('STORAGE_UNAVAILABLE')
      }
      if (auth.status === PENDING_IDENTITY_STATE.CORRUPT_OR_UNKNOWN_PENDING) {
        throw new Error('CORRUPT_OR_UNKNOWN_PENDING')
      }
      if (
        auth.status === PENDING_IDENTITY_STATE.RECOVERABLE_PENDING ||
        auth.status === PENDING_IDENTITY_STATE.LEGACY_UNRECOVERABLE_PENDING ||
        auth.status !== PENDING_IDENTITY_STATE.ABSENT_CONFIRMED
      ) {
        throw new Error('PENDING_IDENTITY_EXISTS')
      }
      if (!this.tryAcquireWalletActivation()) {
        throw new Error('WALLET_ACTIVATION_IN_PROGRESS')
      }
      try {
        const mnemonic = generateMnemonic(wordlist, 128)
        const profileId = DEFAULT_NEW_WALLET_PROFILE_ID
        let ciphertext: string | undefined
        if (password) {
          ciphertext = await encryptWithPassword(mnemonic, password)
        }

        await this.activateMnemonicLocalIdentity(mnemonic, profileId)
        this.encryptedMnemonic = null
        try {
          await (this.wallet as MinimalXecWallet).initialize()
        } catch (error) {
          this.decryptedMnemonic = null
          this.wallet = null
          this.isReady = false
          this.activeAccountState = null
          throw error
        }
        const ownerToken = generateOwnerToken()
        const commitment = await computeMnemonicCommitment(mnemonic)
        const candidateAddress = this.getAddress() || ''
        try {
          setPendingIdentityRecord({
            version: 1,
            ownerToken,
            commitment,
            address: candidateAddress,
            derivationProfileId: profileId,
            ciphertext,
            encryptedMnemonic: ciphertext,
            state: ciphertext ? 'PENDING_BACKUP' : undefined,
            createdAt: Date.now()
          })

          const readBack = getPendingIdentityRecord()
          if (
            !readBack ||
            readBack.ownerToken !== ownerToken ||
            readBack.commitment !== commitment ||
            readBack.address !== candidateAddress
          ) {
            throw new Error('PENDING_IDENTITY_PERSIST_FAILED')
          }
          if (ciphertext) {
            if (readBack.ciphertext !== ciphertext && readBack.encryptedMnemonic !== ciphertext) {
              throw new Error('PENDING_IDENTITY_PERSIST_FAILED')
            }
            const decrypted = await decryptWithPassword(
              readBack.ciphertext || readBack.encryptedMnemonic!,
              password!
            )
            if (decrypted.plainText.trim() !== mnemonic.trim()) {
              throw new Error('PENDING_IDENTITY_PERSIST_FAILED')
            }
          }

          this.pendingIdentityOwnerToken = ownerToken
        } catch (error) {
          this.decryptedMnemonic = null
          this.wallet = null
          this.isReady = false
          this.activeAccountState = null
          this.pendingIdentityOwnerToken = null
          throw error
        }
        return this.decryptedMnemonic || ''
      } finally {
        this.releaseWalletActivation()
      }
    })
  }

  private async activateMnemonicLocalIdentity(
    mnemonic: string,
    profileId: DerivationProfileId
  ): Promise<void> {
    this.buildWallet(profileId)
    const wallet = this.wallet as MinimalXecWallet
    await wallet.walletInfoPromise
    this.decryptedMnemonic = mnemonic
    this.activeAccountState = deriveAccountPublicState(mnemonic, profileId)
    this.bindMinimalWalletToCanonicalProfile(mnemonic)
    this.isReady = true
    this.scanCache = null
    this.scanPromise = null
    this.scanPromiseGapLimit = null
    this.ensureHdAddressCache(this.getEffectiveGapLimit())
  }

  async createQuickStartWallet(): Promise<{ address: string; profileId: DerivationProfileId }> {
    return withQuickStartCreationLock(async () => {
      if (this.hasBackedWalletCiphertextOnDevice()) {
        throw new Error('BACKED_WALLET_EXISTS')
      }
      if (await hasQuickStartMnemonic()) {
        const recovered = await this.activateQuickStartFromDevice()
        if (!recovered) {
          throw new Error('QUICK_START_RECOVERY_FAILED')
        }
        return recovered
      }
      const auth = inspectPendingIdentityAuthority()
      if (auth.status === PENDING_IDENTITY_STATE.STORAGE_UNAVAILABLE) {
        throw new Error('STORAGE_UNAVAILABLE')
      }
      if (auth.status === PENDING_IDENTITY_STATE.CORRUPT_OR_UNKNOWN_PENDING) {
        throw new Error('CORRUPT_OR_UNKNOWN_PENDING')
      }
      if (auth.status !== PENDING_IDENTITY_STATE.ABSENT_CONFIRMED) {
        throw new Error('PENDING_IDENTITY_EXISTS')
      }

      await assertQuickStartStorageAvailable()
      if (!this.tryAcquireWalletActivation()) {
        throw new Error('WALLET_ACTIVATION_IN_PROGRESS')
      }
      try {
        const mnemonic = generateMnemonic(wordlist, 128)
        await this.activateMnemonicLocalIdentity(mnemonic, DEFAULT_NEW_WALLET_PROFILE_ID)
        const profileId = this.activeProfileId
        const address = this.getAddress()
        if (!mnemonic || !address) {
          throw new Error('QUICK_START_WALLET_IDENTITY_MISSING')
        }
        try {
          await storeQuickStartMnemonic(mnemonic, {
            derivationProfileId: profileId,
            address
          })
        } catch (error) {
          this.decryptedMnemonic = null
          this.wallet = null
          this.isReady = false
          this.activeAccountState = null
          if (
            error instanceof Error
            && error.message === 'QUICK_START_RECORD_EXISTS'
          ) {
            const recovered = await this.activateQuickStartFromDevice()
            if (!recovered) {
              throw new Error('QUICK_START_RECOVERY_FAILED')
            }
            return recovered
          }
          throw error
        }
        const persistedMnemonic = await loadQuickStartMnemonic()
        const persistedMetadata = await loadQuickStartMetadata()
        if (
          persistedMnemonic !== mnemonic
          || !persistedMetadata
          || (persistedMetadata.address && persistedMetadata.address !== address)
        ) {
          this.decryptedMnemonic = null
          this.wallet = null
          this.isReady = false
          this.activeAccountState = null
          throw new Error('QUICK_START_IDENTITY_MISMATCH')
        }
        try {
          await (this.wallet as MinimalXecWallet).initialize()
        } catch {
          // Chronik/network failure must not prevent first-create persistence.
        }
        return { address, profileId }
      } finally {
        this.releaseWalletActivation()
      }
    })
  }

  async activateQuickStartWallet(
    mnemonic: string,
    profileId: DerivationProfileId
  ): Promise<{ address: string; profileId: DerivationProfileId }> {
    if (!this.tryAcquireWalletActivation()) {
      throw new Error('WALLET_ACTIVATION_IN_PROGRESS')
    }
    try {
      const normalizedMnemonic = mnemonic.trim()
      if (!normalizedMnemonic) {
        throw new Error('QUICK_START_MNEMONIC_REQUIRED')
      }
      if (!isDerivationProfileId(profileId)) {
        throw new Error('QUICK_START_DERIVATION_PROFILE_REQUIRED')
      }
      await this.activateMnemonicLocalIdentity(normalizedMnemonic, profileId)
      try {
        await (this.wallet as MinimalXecWallet).initialize()
      } catch {
        // Chronik/network failure must not destroy a recoverable local identity.
      }
      const address = this.getAddress()
      if (!address) {
        throw new Error('QUICK_START_WALLET_IDENTITY_MISSING')
      }
      return { address, profileId }
    } finally {
      this.releaseWalletActivation()
    }
  }

  async activateQuickStartFromDevice(): Promise<{ address: string; profileId: DerivationProfileId } | null> {
    const metadata = await loadQuickStartMetadata()
    if (!metadata) return null
    const mnemonic = await loadQuickStartMnemonic()
    if (!mnemonic) return null
    return this.activateQuickStartWallet(mnemonic, metadata.derivationProfileId)
  }

  private async activeQuickStartIdentityMatches(): Promise<boolean> {
    const metadata = await loadQuickStartMetadata()
    const quickStartMnemonic = await loadQuickStartMnemonic()
    const activeMnemonic = this.getMnemonic()
    const activeAddress = this.getAddress()
    return Boolean(
      metadata && quickStartMnemonic && activeMnemonic && activeAddress
      && quickStartMnemonic === activeMnemonic
      && metadata.address === activeAddress
      && metadata.derivationProfileId === this.activeProfileId
    )
  }

  async resolveQuickStartLifecycleAfterActivation(): Promise<{
    lifecycle: typeof WALLET_LIFECYCLE.BACKUP_VERIFIED | typeof WALLET_LIFECYCLE.QUICK_START_UNBACKED
    backupVerified: boolean
    recoveryState: QuickStartRecoveryState
  }> {
    return withIdentityMutationLock(async () => {
      // Read both authorities only after acquiring the same lock used by backup commit.
      const ciphertext = localStorage.getItem(STORAGE_KEY_MNEMONIC)
      const marker = localStorage.getItem(BACKUP_KEY)
      if (ciphertext && marker === 'true') {
        return { lifecycle: WALLET_LIFECYCLE.BACKUP_VERIFIED, backupVerified: true, recoveryState: 'BACKUP_VERIFIED' }
      }
      if (ciphertext === '' || marker === 'true' || (marker !== null && marker !== 'false')) {
        throw new Error('QUICK_START_LIFECYCLE_INCONSISTENT')
      }

      const status = await getQuickStartRecordStatus()
      if (status !== 'PRESENT' || !(await this.activeQuickStartIdentityMatches().catch(() => false))) {
        throw new Error('QUICK_START_LIFECYCLE_INCONSISTENT')
      }
      if (ciphertext !== null) {
        return { lifecycle: WALLET_LIFECYCLE.QUICK_START_UNBACKED, backupVerified: false, recoveryState: 'INTERRUPTED_BACKUP' }
      }

      localStorage.setItem(BACKUP_KEY, 'false')
      return { lifecycle: WALLET_LIFECYCLE.QUICK_START_UNBACKED, backupVerified: false, recoveryState: 'NORMAL_UNBACKED' }
    })
  }

  async hasQuickStartRecord(): Promise<boolean> {
    const status = await getQuickStartRecordStatus()
    if (status === 'PRESENT') return true
    if (status === 'STORAGE_UNAVAILABLE_UNKNOWN') {
      throw new QuickStartUnavailableError('QUICK_START_STORAGE_UNAVAILABLE_UNKNOWN')
    }
    if (status === 'RECOVERY_FAILED') {
      throw new Error('QUICK_START_RECOVERY_FAILED')
    }
    return false
  }

  async getQuickStartRecordStatus(): Promise<QuickStartRecordStatus> {
    return getQuickStartRecordStatus()
  }

  async verifyStoredMnemonic(password: string, expectedMnemonic: string): Promise<boolean> {
    const stored = typeof window === 'undefined'
      ? this.encryptedMnemonic
      : localStorage.getItem(STORAGE_KEY_MNEMONIC)
    if (!stored) return false
    try {
      const { plainText } = await decryptWithPassword(stored, password)
      return plainText.trim() === expectedMnemonic.trim()
    } catch {
      return false
    }
  }

  async persistVerifiedBackup(password: string): Promise<void> {
    return withQuickStartCreationLock(async () => {
      const mnemonic = this.getMnemonic()
      if (!mnemonic) {
        throw new Error('No hay semilla en memoria para cifrar. Vuelve a iniciar el onboarding y el respaldo.')
      }

      const existingFinalCiphertext = typeof window === 'undefined'
        ? this.encryptedMnemonic
        : localStorage.getItem(STORAGE_KEY_MNEMONIC)
      let reuseExistingFinalCiphertext = false
      if (existingFinalCiphertext !== null && await getQuickStartRecordStatus() === 'PRESENT') {
        const identityMatches = await this.activeQuickStartIdentityMatches().catch(() => false)
        if (!identityMatches) {
          throw new Error('INTERRUPTED_BACKUP_VERIFICATION_FAILED')
        }
        try {
          const decrypted = await decryptWithPassword(existingFinalCiphertext, password)
          if (decrypted.plainText.trim() !== mnemonic.trim()) {
            throw new Error('INTERRUPTED_BACKUP_VERIFICATION_FAILED')
          }
        } catch {
          throw new Error('INTERRUPTED_BACKUP_VERIFICATION_FAILED')
        }
        reuseExistingFinalCiphertext = true
      } else if (this.hasBackedWalletCiphertextOnDevice()) {
        const matches = await this.verifyStoredMnemonic(password, mnemonic).catch(() => false)
        if (!matches) {
          throw new Error('BACKUP_OVERWRITE_PREVENTED')
        }
      }

      // Step 1: Inspect authoritative pending identity state BEFORE any modification
      const auth = inspectPendingIdentityAuthority()

      if (auth.status === PENDING_IDENTITY_STATE.STORAGE_UNAVAILABLE) {
        throw new Error('PENDING_IDENTITY_STORAGE_UNAVAILABLE')
      }

      if (auth.status === PENDING_IDENTITY_STATE.CORRUPT_OR_UNKNOWN_PENDING) {
        throw new Error('PENDING_IDENTITY_CORRUPT_DURING_BACKUP')
      }

      let activePendingRecord: PendingIdentityRecord | null = null

      if (
        auth.status === PENDING_IDENTITY_STATE.RECOVERABLE_PENDING ||
        auth.status === PENDING_IDENTITY_STATE.LEGACY_UNRECOVERABLE_PENDING
      ) {
        const pendingRecord = auth.record
        const commitment = await computeMnemonicCommitment(mnemonic)
        if (pendingRecord.commitment !== commitment) {
          throw new Error('PENDING_IDENTITY_MISMATCH')
        }
        if (!this.pendingIdentityOwnerToken || pendingRecord.ownerToken !== this.pendingIdentityOwnerToken) {
          throw new Error('PENDING_IDENTITY_OWNER_MISMATCH')
        }
        const activeAddress = this.getAddress()
        if (pendingRecord.address && (!activeAddress || pendingRecord.address !== activeAddress)) {
          throw new Error('PENDING_IDENTITY_MISMATCH')
        }
        if (
          pendingRecord.derivationProfileId &&
          (!this.activeProfileId || pendingRecord.derivationProfileId !== this.activeProfileId)
        ) {
          throw new Error('PENDING_IDENTITY_MISMATCH')
        }

        const updatedCiphertext = await encryptWithPassword(mnemonic, password)
        const updatePayload: Parameters<typeof setPendingIdentityRecord>[0] = {
          version: 1,
          ownerToken: pendingRecord.ownerToken,
          commitment: pendingRecord.commitment,
          address: pendingRecord.address,
          ciphertext: updatedCiphertext,
          encryptedMnemonic: updatedCiphertext,
          state: 'PENDING_BACKUP',
          createdAt: pendingRecord.createdAt
        }
        if (pendingRecord.derivationProfileId) {
          updatePayload.derivationProfileId = pendingRecord.derivationProfileId
        }
        setPendingIdentityRecord(updatePayload)

        const readBack = getPendingIdentityRecord()
        if (
          !readBack ||
          readBack.ownerToken !== pendingRecord.ownerToken ||
          readBack.commitment !== pendingRecord.commitment ||
          readBack.address !== pendingRecord.address ||
          (pendingRecord.derivationProfileId && readBack.derivationProfileId !== pendingRecord.derivationProfileId) ||
          (readBack.ciphertext !== updatedCiphertext && readBack.encryptedMnemonic !== updatedCiphertext)
        ) {
          throw new Error('PENDING_IDENTITY_PERSIST_FAILED')
        }

        const readBackCipher = readBack.ciphertext || readBack.encryptedMnemonic
        if (!readBackCipher) {
          throw new Error('PENDING_IDENTITY_PERSIST_FAILED')
        }
        const decrypted = await decryptWithPassword(readBackCipher, password)
        if (decrypted.plainText.trim() !== mnemonic.trim()) {
          throw new Error('PENDING_IDENTITY_PERSIST_FAILED')
        }

        activePendingRecord = pendingRecord
      } else if (auth.status === PENDING_IDENTITY_STATE.ABSENT_CONFIRMED) {
        // Documented legitimate workflows for completing backup when pending reservation is ABSENT_CONFIRMED:
        // 1. Quick Start progressive backup: unbacked Quick Start identities are stored in Quick Start storage
        //    (loadQuickStartMnemonic / hasQuickStartRecord) and intentionally do NOT register a pending identity reservation.
        // 2. Existing backed wallet re-encryption/verification: device already holds verified backed ciphertext matching active mnemonic.
        //
        // In contrast, fresh create-backed and import workflows MUST hold an active pending reservation
        // matching this.pendingIdentityOwnerToken. If missing or absent during those workflows, fail closed.
        if (this.pendingIdentityOwnerToken !== null) {
          throw new Error('PENDING_IDENTITY_MISSING')
        }

        const isQuickStart = (await hasQuickStartMnemonic()) || (await this.hasQuickStartRecord().catch(() => false))
        const isExistingBacked = this.hasBackedWalletCiphertextOnDevice()

        if (!isQuickStart && !isExistingBacked) {
          throw new Error('PENDING_IDENTITY_RESERVATION_REQUIRED')
        }
      } else {
        throw new Error('PENDING_IDENTITY_CORRUPT_DURING_BACKUP')
      }

      if (await hasQuickStartMnemonic()) {
        const storedMnemonic = await loadQuickStartMnemonic().catch(() => null)
        if (storedMnemonic && storedMnemonic !== mnemonic) {
          throw new Error('QUICK_START_WALLET_EXISTS')
        }
      }
      if (!reuseExistingFinalCiphertext) {
        await this.encryptAndStoreMnemonic(password)
      }
      const verified = await this.verifyStoredMnemonic(password, mnemonic)
      if (!verified) {
        throw new Error(reuseExistingFinalCiphertext
          ? 'INTERRUPTED_BACKUP_VERIFICATION_FAILED'
          : 'QUICK_START_BACKUP_VERIFY_FAILED')
      }
      try {
        localStorage.setItem(BACKUP_KEY, 'true')
        if (localStorage.getItem(BACKUP_KEY) !== 'true') {
          throw new Error('BACKUP_VERIFIED_MARKER_PERSIST_FAILED')
        }
      } catch {
        throw new Error('BACKUP_VERIFIED_MARKER_PERSIST_FAILED')
      }
      if (reuseExistingFinalCiphertext) this.encryptedMnemonic = existingFinalCiphertext
      if (activePendingRecord) {
        deletePendingIdentityRecordVerified()
        if (inspectPendingIdentityAuthority().status !== PENDING_IDENTITY_STATE.ABSENT_CONFIRMED) {
          throw new Error('PENDING_IDENTITY_ABANDON_FAILED')
        }
      }
      this.pendingIdentityOwnerToken = null
    })
  }

  async discardQuickStartRecord(): Promise<void> {
    const currentMnemonic = this.getMnemonic()
    if (currentMnemonic) {
      try {
        const storedMnemonic = await loadQuickStartMnemonic()
        if (storedMnemonic && storedMnemonic !== currentMnemonic) {
          return
        }
      } catch {
        // If loading fails due to unavailable storage or corrupt record, proceed
      }
    }
    await clearQuickStartMnemonic()
  }


  async detectDerivationProfiles(mnemonic: string): Promise<DerivationDiscovery> {
    if (!mnemonic || mnemonic.trim().split(' ').length < 12) {
      throw new Error('La frase semilla es inválida.')
    }
    return discoverDerivationProfile(mnemonic.trim(), this.getEffectiveGapLimit(), {
      readAddress: async address => {
        const scan = await this.fetchAddressScan(address)
        return Object.freeze({ utxos: scan.utxos, hasHistory: scan.hasHistory })
      }
    })
  }

  async restoreFromMnemonic(
    mnemonic: string,
    selectedProfileId?: DerivationProfileId,
    password?: string
  ): Promise<WalletRestoreResult> {
    return withQuickStartCreationLock(async () => {
      if (this.hasBackedWalletCiphertextOnDevice()) {
        throw new Error('BACKED_WALLET_EXISTS')
      }
      if (await hasQuickStartMnemonic()) {
        throw new Error('QUICK_START_RECORD_EXISTS')
      }
      const auth = inspectPendingIdentityAuthority()
      if (auth.status === PENDING_IDENTITY_STATE.STORAGE_UNAVAILABLE) {
        throw new Error('STORAGE_UNAVAILABLE')
      }
      if (auth.status === PENDING_IDENTITY_STATE.CORRUPT_OR_UNKNOWN_PENDING) {
        throw new Error('CORRUPT_OR_UNKNOWN_PENDING')
      }
      if (
        auth.status === PENDING_IDENTITY_STATE.RECOVERABLE_PENDING ||
        auth.status === PENDING_IDENTITY_STATE.LEGACY_UNRECOVERABLE_PENDING ||
        auth.status !== PENDING_IDENTITY_STATE.ABSENT_CONFIRMED
      ) {
        throw new Error('PENDING_IDENTITY_EXISTS')
      }
      if (!this.tryAcquireWalletActivation()) {
        throw new Error('WALLET_ACTIVATION_IN_PROGRESS')
      }
      try {
        const normalizedMnemonic = mnemonic.trim()
        const detection = await this.detectDerivationProfiles(normalizedMnemonic)

        if (detection.kind === 'choice-required' && selectedProfileId === undefined) {
          return Object.freeze({
            status: 'choice-required',
            detection,
            notice: 'Encontramos actividad en varios engines asociados a esta seed. Elige cuál quieres abrir.'
          })
        }

        const resolvedProfileId = selectedProfileId ?? detection.selectedProfileId
        if (!isDerivationProfileId(resolvedProfileId)) {
          throw new Error('No se pudo resolver un perfil de derivación válido.')
        }
        if (
          detection.kind === 'choice-required' &&
          !detection.profiles[resolvedProfileId].hasActivity
        ) {
          throw new Error('El perfil solicitado no contiene actividad detectada para esta seed.')
        }
        if (
          detection.kind === 'selected' &&
          detection.selectedProfileId !== resolvedProfileId
        ) {
          throw new Error('El perfil solicitado no coincide con la actividad detectada para esta seed.')
        }

        let ciphertext: string | undefined
        if (password) {
          ciphertext = await encryptWithPassword(normalizedMnemonic, password)
        }

        await this.activateMnemonic(normalizedMnemonic, resolvedProfileId)
        const ownerToken = generateOwnerToken()
        const commitment = await computeMnemonicCommitment(normalizedMnemonic)
        const candidateAddress = this.getAddress() || ''
        try {
          setPendingIdentityRecord({
            version: 1,
            ownerToken,
            commitment,
            address: candidateAddress,
            derivationProfileId: resolvedProfileId,
            ciphertext,
            encryptedMnemonic: ciphertext,
            state: ciphertext ? 'PENDING_BACKUP' : undefined,
            createdAt: Date.now()
          })

          const readBack = getPendingIdentityRecord()
          if (
            !readBack ||
            readBack.ownerToken !== ownerToken ||
            readBack.commitment !== commitment ||
            readBack.address !== candidateAddress
          ) {
            throw new Error('PENDING_IDENTITY_PERSIST_FAILED')
          }
          if (ciphertext) {
            if (readBack.ciphertext !== ciphertext && readBack.encryptedMnemonic !== ciphertext) {
              throw new Error('PENDING_IDENTITY_PERSIST_FAILED')
            }
            const decrypted = await decryptWithPassword(
              readBack.ciphertext || readBack.encryptedMnemonic!,
              password!
            )
            if (decrypted.plainText.trim() !== normalizedMnemonic) {
              throw new Error('PENDING_IDENTITY_PERSIST_FAILED')
            }
          }

          this.pendingIdentityOwnerToken = ownerToken
        } catch (error) {
          this.decryptedMnemonic = null
          this.wallet = null
          this.isReady = false
          this.activeAccountState = null
          this.pendingIdentityOwnerToken = null
          throw error
        }
        const notice = resolvedProfileId === ECASH_STANDARD_PROFILE_ID
          ? detection.reason === 'empty'
            ? 'No se encontró actividad previa. Se utilizará el perfil compatible con eCash/Cashtab.'
            : 'Se encontró una wallet compatible con eCash/Cashtab.'
          : resolvedProfileId === TONALLI_LEGACY_PROFILE_ID
            ? 'Se encontró una wallet Tonalli con derivación criptográfica histórica.'
            : 'Se encontró una wallet de la ventana transitoria eCash Standard 899.'

        return Object.freeze({
          status: 'restored',
          detection,
          selectedProfileId: resolvedProfileId,
          notice
        })
      } finally {
        this.releaseWalletActivation()
      }
    })
  }

  async loadFromStorage(
    password: string,
    selectedProfileId?: DerivationProfileId
  ): Promise<WalletLoadResult> {
    if (!this.tryAcquireWalletActivation()) {
      throw new Error('WALLET_ACTIVATION_IN_PROGRESS')
    }
    try {
      const { plainText, migratedCipherText } = await this.decryptStoredMnemonic(password)
      this.persistMigratedStoredMnemonic(migratedCipherText)
      return await this.activateDecryptedStoredMnemonic(plainText, selectedProfileId)
    } finally {
      this.releaseWalletActivation()
    }
  }

  private async decryptStoredMnemonic(password: string): Promise<DecryptPasswordResult> {
    if (!this.encryptedMnemonic) {
      throw new Error('No existe una semilla cifrada en este dispositivo.')
    }
    return decryptWithPassword(this.encryptedMnemonic, password)
  }

  private persistMigratedStoredMnemonic(migratedCipherText: string | null): void {
    if (!migratedCipherText) return
    localStorage.setItem(STORAGE_KEY_MNEMONIC, migratedCipherText)
    this.encryptedMnemonic = migratedCipherText
  }

  private async activateDecryptedStoredMnemonic(
    plainText: string,
    selectedProfileId?: DerivationProfileId
  ): Promise<WalletLoadResult> {
    const storedMetadata = parseStoredDerivationProfileMetadata(
      typeof window === 'undefined' ? null : localStorage.getItem(DERIVATION_PROFILE_STORAGE_KEY)
    )
    if (storedMetadata) {
      await this.activateMnemonic(plainText, storedMetadata.derivationProfile)
      return Object.freeze({
        status: 'loaded',
        selectedProfileId: storedMetadata.derivationProfile,
        notice: 'Se cargó el perfil de derivación guardado.'
      })
    }

    const detection = await this.detectDerivationProfiles(plainText)
    const resolvedProfileId = resolveProfileForMissingMetadata(detection, selectedProfileId)
    if (resolvedProfileId === undefined) {
      return Object.freeze({
        status: 'choice-required',
        detection,
        notice: 'Falta metadata del engine y hay actividad en varios candidatos. Elige cuál abrir.'
      })
    }

    await this.activateMnemonic(plainText, resolvedProfileId, true)
    return Object.freeze({
      status: 'loaded',
      detection,
      selectedProfileId: resolvedProfileId,
      notice: detection.reason === 'empty'
        ? 'Wallet histórica sin actividad: se conservó el perfil Tonalli Legacy.'
        : resolvedProfileId === ECASH_STANDARD_PROFILE_ID
          ? 'Se recuperó y guardó el perfil eCash/Cashtab detectado.'
          : resolvedProfileId === TONALLI_LEGACY_PROFILE_ID
            ? 'Se recuperó y guardó el engine criptográfico Tonalli Legacy histórico.'
            : 'Se recuperó y guardó el perfil transitorio eCash Standard 899.'
    })
  }

  async unlockEncryptedWallet(password: string): Promise<void> {
    if (!this.tryAcquireWalletActivation()) {
      throw new Error('WALLET_ACTIVATION_IN_PROGRESS')
    }
    try {
      const { plainText, migratedCipherText } = await this.decryptStoredMnemonic(password)
      this.persistMigratedStoredMnemonic(migratedCipherText)
      this.decryptedMnemonic = plainText
    } finally {
      this.releaseWalletActivation()
    }
  }

  hasEncryptedWalletOnDevice(): boolean {
    try {
      const storedCiphertext = typeof window === 'undefined'
        ? this.encryptedMnemonic
        : localStorage.getItem(STORAGE_KEY_MNEMONIC)
      return storedCiphertext !== null && storedCiphertext === this.encryptedMnemonic
    } catch {
      return false
    }
  }

  hasBackedWalletCiphertextOnDevice(): boolean {
    try {
      if (typeof window === 'undefined') {
        return Boolean(this.encryptedMnemonic)
      }
      const storedCiphertext = localStorage.getItem(STORAGE_KEY_MNEMONIC)
      if (typeof storedCiphertext === 'string' && storedCiphertext.length > 0) {
        return true
      }
      return Boolean(this.encryptedMnemonic)
    } catch {
      return true
    }
  }

  async activateStoredWalletForX402(
    password: string
  ): Promise<X402StoredWalletActivationResult> {
    if (!this.tryAcquireWalletActivation()) {
      throw new X402StoredWalletActivationError('activation-failed')
    }

    const previousState = {
      wallet: this.wallet,
      isReady: this.isReady,
      decryptedMnemonic: this.decryptedMnemonic,
      scanCache: this.scanCache,
      scanPromise: this.scanPromise,
      scanPromiseGapLimit: this.scanPromiseGapLimit,
      hdAddressCache: this.hdAddressCache,
      activeProfileId: this.activeProfileId,
      activeAccountState: this.activeAccountState
    }
    let previousProfileMetadata: string | null | undefined
    let previousStoredCiphertext: string | null | undefined
    let expectedStoredCiphertextAfterActivation: string | null | undefined
    let expectedProfileMetadataAfterActivation: string | null | undefined
    let committed = false

    try {
      try {
        if (typeof window === 'undefined') {
          previousProfileMetadata = undefined
          previousStoredCiphertext = this.encryptedMnemonic
        } else {
          previousProfileMetadata = localStorage.getItem(DERIVATION_PROFILE_STORAGE_KEY)
          previousStoredCiphertext = localStorage.getItem(STORAGE_KEY_MNEMONIC)
        }
        if (
          previousStoredCiphertext === null ||
          previousStoredCiphertext !== this.encryptedMnemonic
        ) {
          throw new Error('X402_STORED_WALLET_CHANGED')
        }
      } catch {
        throw new X402StoredWalletActivationError('activation-failed')
      }

      let decrypted: DecryptPasswordResult
      try {
        decrypted = await this.decryptStoredMnemonic(password)
      } catch {
        throw new X402StoredWalletActivationError('unlock-failed')
      }

      let result: WalletLoadResult
      try {
        if (
          typeof window !== 'undefined' &&
          (
            localStorage.getItem(STORAGE_KEY_MNEMONIC) !== previousStoredCiphertext ||
            localStorage.getItem(DERIVATION_PROFILE_STORAGE_KEY) !== previousProfileMetadata
          )
        ) {
          throw new Error('X402_STORED_WALLET_CHANGED')
        }
        expectedStoredCiphertextAfterActivation =
          decrypted.migratedCipherText ?? previousStoredCiphertext
        this.persistMigratedStoredMnemonic(decrypted.migratedCipherText)
        result = await this.activateDecryptedStoredMnemonic(decrypted.plainText)

        expectedProfileMetadataAfterActivation =
          result.status === 'loaded' &&
          parseStoredDerivationProfileMetadata(previousProfileMetadata ?? null) === null
            ? serializeStoredDerivationProfileMetadata(this.activeProfileId)
            : previousProfileMetadata
        if (
          typeof window !== 'undefined' &&
          (
            localStorage.getItem(STORAGE_KEY_MNEMONIC) !==
              expectedStoredCiphertextAfterActivation ||
            localStorage.getItem(DERIVATION_PROFILE_STORAGE_KEY) !==
              expectedProfileMetadataAfterActivation
          )
        ) {
          throw new Error('X402_STORED_WALLET_CHANGED')
        }
      } catch {
        throw new X402StoredWalletActivationError('activation-failed')
      }

      if (result.status === 'choice-required') {
        return Object.freeze({ status: 'choice-required' })
      }

      let account: X402WalletAccount | null
      try {
        account = this.getX402ActiveAccount()
      } catch {
        throw new X402StoredWalletActivationError('activation-failed')
      }
      if (!isCanonicalX402WalletAccount(account)) {
        throw new X402StoredWalletActivationError('activation-failed')
      }

      committed = true
      return Object.freeze({
        status: 'active',
        account: Object.freeze({ ...account })
      })
    } finally {
      try {
        if (!committed) {
          this.wallet = previousState.wallet
          this.isReady = previousState.isReady
          this.decryptedMnemonic = previousState.decryptedMnemonic
          this.scanCache = previousState.scanCache
          this.scanPromise = previousState.scanPromise
          this.scanPromiseGapLimit = previousState.scanPromiseGapLimit
          this.hdAddressCache = previousState.hdAddressCache
          this.activeProfileId = previousState.activeProfileId
          this.activeAccountState = previousState.activeAccountState

          if (previousProfileMetadata !== undefined && typeof window !== 'undefined') {
            try {
              const currentProfileMetadata = localStorage.getItem(
                DERIVATION_PROFILE_STORAGE_KEY
              )
              const rollbackComparison = expectedProfileMetadataAfterActivation ??
                previousProfileMetadata
              const currentStoredCiphertext = localStorage.getItem(STORAGE_KEY_MNEMONIC)
              const expectedStoredCiphertext = expectedStoredCiphertextAfterActivation ??
                previousStoredCiphertext
              if (
                currentProfileMetadata === rollbackComparison &&
                currentStoredCiphertext === expectedStoredCiphertext
              ) {
                if (previousProfileMetadata === null) {
                  localStorage.removeItem(DERIVATION_PROFILE_STORAGE_KEY)
                } else {
                  localStorage.setItem(DERIVATION_PROFILE_STORAGE_KEY, previousProfileMetadata)
                }
              }
            } catch {
              // In-memory rollback remains authoritative if storage becomes unavailable.
            }
          }
        }
      } finally {
        this.releaseWalletActivation()
      }
    }
  }

  async encryptAndStoreMnemonic(password: string): Promise<void> {
    if (!this.tryAcquireWalletActivation()) {
      throw new Error('WALLET_ACTIVATION_IN_PROGRESS')
    }
    try {
      let mnemonic = this.decryptedMnemonic

      const walletMnemonic = this.wallet?.mnemonic || this.wallet?.walletInfo?.mnemonic
      if (!mnemonic && walletMnemonic) {
        mnemonic = walletMnemonic
        this.decryptedMnemonic = mnemonic
      }

      if (!mnemonic) {
        throw new Error('No hay semilla en memoria para cifrar. Vuelve a iniciar el onboarding y el respaldo.')
      }

      const cipherText = await encryptWithPassword(mnemonic, password)
      localStorage.setItem(STORAGE_KEY_MNEMONIC, cipherText)
      this.encryptedMnemonic = cipherText
      this.persistActiveProfile()
    } finally {
      this.releaseWalletActivation()
    }
  }

  clearStoredWallet(): void {
    if (!this.tryAcquireWalletActivation()) {
      throw new Error('WALLET_ACTIVATION_IN_PROGRESS')
    }
    try {
      localStorage.removeItem(STORAGE_KEY_MNEMONIC)
      localStorage.removeItem(DERIVATION_PROFILE_STORAGE_KEY)
      clearPendingIdentityRecord()
      this.pendingIdentityOwnerToken = null
      this.encryptedMnemonic = null
      this.decryptedMnemonic = null
      this.wallet = null
      this.isReady = false
      this.scanCache = null
      this.scanPromise = null
      this.scanPromiseGapLimit = null
      this.hdAddressCache = []
      this.activeProfileId = DEFAULT_NEW_WALLET_PROFILE_ID
      this.activeAccountState = null
      this.rmzDecimals = null
      this.rmzDecimalsPromise = null
    } finally {
      this.releaseWalletActivation()
    }
  }

  hasPendingIdentityRecord(): boolean {
    const auth = inspectPendingIdentityAuthority()
    if (auth.status === PENDING_IDENTITY_STATE.ABSENT_CONFIRMED) return false
    if (
      this.pendingIdentityOwnerToken &&
      (auth.status === PENDING_IDENTITY_STATE.RECOVERABLE_PENDING ||
        auth.status === PENDING_IDENTITY_STATE.LEGACY_UNRECOVERABLE_PENDING) &&
      auth.record.ownerToken === this.pendingIdentityOwnerToken
    ) {
      return false
    }
    return true
  }

  getPendingIdentityState(): PendingIdentityState {
    return inspectPendingIdentityAuthority().status
  }

  hasRecoverablePendingIdentity(): boolean {
    const auth = inspectPendingIdentityAuthority()
    if (auth.status !== PENDING_IDENTITY_STATE.RECOVERABLE_PENDING) return false
    return Boolean(
      !this.hasBackedWalletCiphertextOnDevice() &&
      (!this.isReady || !this.pendingIdentityOwnerToken || auth.record.ownerToken !== this.pendingIdentityOwnerToken)
    )
  }

  async resumePendingIdentity(password: string): Promise<{ address: string; mnemonic: string; reconciled: boolean }> {
    return withIdentityMutationLock(async () => {
      const auth = inspectPendingIdentityAuthority()
      if (auth.status === PENDING_IDENTITY_STATE.ABSENT_CONFIRMED) {
        throw new Error('NO_PENDING_IDENTITY')
      }
      if (auth.status !== PENDING_IDENTITY_STATE.RECOVERABLE_PENDING) {
        throw new Error('PENDING_IDENTITY_NOT_RECOVERABLE')
      }
      const pending = auth.record
      const ciphertext = pending.ciphertext || pending.encryptedMnemonic
      const profileId = pending.derivationProfileId
      if (!ciphertext || !profileId) {
        throw new Error('PENDING_IDENTITY_NOT_RECOVERABLE')
      }

      let decryptedPlainText = ''
      try {
        const decrypted = await decryptWithPassword(ciphertext, password)
        decryptedPlainText = decrypted.plainText.trim()
      } catch {
        // PIN incorrecto: no alterar pending record, no generar nueva identity, no limpiar reservation
        throw new Error('INVALID_PIN')
      }

      const mnemonic = decryptedPlainText
      const commitment = await computeMnemonicCommitment(mnemonic)
      if (commitment !== pending.commitment) {
        throw new Error('PENDING_IDENTITY_COMMITMENT_MISMATCH')
      }

      await this.activateMnemonicLocalIdentity(mnemonic, profileId)
      const derivedAddress = this.getAddress() || ''
      if (derivedAddress !== pending.address) {
        this.decryptedMnemonic = null
        this.wallet = null
        this.isReady = false
        this.activeAccountState = null
        this.pendingIdentityOwnerToken = null
        throw new Error('PENDING_IDENTITY_ADDRESS_MISMATCH')
      }

      let reconciled = false
      if (this.hasBackedWalletCiphertextOnDevice()) {
        const matches = await this.verifyStoredMnemonic(password, mnemonic).catch(() => false)
        if (!matches) {
          this.decryptedMnemonic = null
          this.wallet = null
          this.isReady = false
          this.activeAccountState = null
          this.pendingIdentityOwnerToken = null
          throw new Error('PENDING_IDENTITY_RECONCILIATION_MISMATCH')
        }
        deletePendingIdentityRecordVerified()
        if (inspectPendingIdentityAuthority().status !== PENDING_IDENTITY_STATE.ABSENT_CONFIRMED) {
          throw new Error('PENDING_IDENTITY_ABANDON_FAILED')
        }
        try {
          localStorage.setItem('xoloswallet_backup_verified', 'true')
        } catch {
          // The exact final ciphertext remains authoritative even if the convenience marker cannot be refreshed.
        }
        reconciled = true
      }

      this.pendingIdentityOwnerToken = reconciled ? null : pending.ownerToken

      try {
        await (this.wallet as MinimalXecWallet).initialize()
      } catch {
        // Network hydration is best-effort. The locally authenticated identity remains usable for backup.
      }

      return { address: derivedAddress, mnemonic, reconciled }
    })
  }

  private async abandonPendingIdentityWithExpectedState(expectedState: PendingIdentityState): Promise<void> {
    const auth = inspectPendingIdentityAuthority()
    if (auth.status === PENDING_IDENTITY_STATE.ABSENT_CONFIRMED) {
      throw new Error('NO_PENDING_IDENTITY')
    }
    if (auth.status !== expectedState) {
      throw new Error('PENDING_IDENTITY_STATE_CHANGED')
    }
    const pending = (auth as { record: PendingIdentityRecord }).record
    if (this.pendingIdentityOwnerToken === pending.ownerToken) {
      throw new Error('PENDING_IDENTITY_SESSION_ACTIVE')
    }
    if (this.hasBackedWalletCiphertextOnDevice()) {
      throw new Error('BACKED_WALLET_EXISTS')
    }

    const quickStartStatus = await getQuickStartRecordStatus()
    if (quickStartStatus === 'PRESENT') {
      throw new Error('QUICK_START_RECORD_EXISTS')
    }
    if (quickStartStatus === 'STORAGE_UNAVAILABLE_UNKNOWN') {
      throw new Error('QUICK_START_STORAGE_UNAVAILABLE_UNKNOWN')
    }
    if (quickStartStatus === 'RECOVERY_FAILED') {
      throw new Error('QUICK_START_RECOVERY_FAILED')
    }

    deletePendingIdentityRecordVerified()
    this.pendingIdentityOwnerToken = null
  }

  async abandonCorruptPendingIdentity(): Promise<void> {
    return withIdentityMutationLock(async () => {
      if (typeof localStorage === 'undefined') {
        throw new Error('PENDING_IDENTITY_STORAGE_UNAVAILABLE')
      }
      let raw: string | null
      try {
        raw = localStorage.getItem(PENDING_IDENTITY_STORAGE_KEY)
      } catch {
        throw new Error('PENDING_IDENTITY_STORAGE_UNAVAILABLE')
      }
      if (raw === null) {
        throw new Error('NO_PENDING_IDENTITY')
      }

      const auth = inspectPendingIdentityAuthority()
      if (auth.status !== PENDING_IDENTITY_STATE.CORRUPT_OR_UNKNOWN_PENDING) {
        throw new Error('PENDING_IDENTITY_STATE_CHANGED')
      }

      if (this.hasBackedWalletCiphertextOnDevice()) {
        throw new Error('BACKED_WALLET_EXISTS')
      }

      const quickStartStatus = await getQuickStartRecordStatus()
      if (quickStartStatus === 'PRESENT') {
        throw new Error('QUICK_START_RECORD_EXISTS')
      }
      if (quickStartStatus === 'STORAGE_UNAVAILABLE_UNKNOWN') {
        throw new Error('QUICK_START_STORAGE_UNAVAILABLE_UNKNOWN')
      }
      if (quickStartStatus === 'RECOVERY_FAILED') {
        throw new Error('QUICK_START_RECOVERY_FAILED')
      }

      deletePendingIdentityRecordVerified()
      if (localStorage.getItem(PENDING_IDENTITY_STORAGE_KEY) !== null) {
        throw new Error('PENDING_IDENTITY_ABANDON_FAILED')
      }
      this.pendingIdentityOwnerToken = null
    })
  }

  async abandonLegacyPendingIdentity(): Promise<void> {
    return withIdentityMutationLock(async () => {
      await this.abandonPendingIdentityWithExpectedState(
        PENDING_IDENTITY_STATE.LEGACY_UNRECOVERABLE_PENDING
      )
    })
  }

  async abandonPendingIdentity(): Promise<void> {
    return withIdentityMutationLock(async () => {
      await this.abandonPendingIdentityWithExpectedState(
        PENDING_IDENTITY_STATE.RECOVERABLE_PENDING
      )
    })
  }

  reconcilePendingIdentity(): void {
    // Reconciliation requires the user's PIN and exact mnemonic equivalence proof.
    // It is performed by resumePendingIdentity(); generic ciphertext existence is insufficient.
  }

  getPendingIdentityOwnerToken(): string | null {
    return this.pendingIdentityOwnerToken
  }

  setPendingIdentityOwnerToken(token: string | null): void {
    this.pendingIdentityOwnerToken = token
  }

  private getEffectiveGapLimit(): number {
    const stored = typeof window !== 'undefined' ? parseGapLimit(localStorage.getItem(STORAGE_KEY_GAP_LIMIT)) : null
    const env = parseGapLimit(import.meta.env?.VITE_GAP_LIMIT)
    return clampGapLimit(stored ?? env ?? DEFAULT_GAP_LIMIT)
  }

  private persistGapLimit(value: number): void {
    if (typeof window === 'undefined') return
    localStorage.setItem(STORAGE_KEY_GAP_LIMIT, String(value))
  }

  private getMnemonicOrThrow(): string {
    const mnemonic = this.getMnemonic()
    if (!mnemonic) {
      throw new Error('No hay semilla disponible para derivar direcciones.')
    }
    return mnemonic
  }

  private getAccountStateOrThrow(): AccountPublicState {
    if (!this.activeAccountState) {
      throw new Error('No hay un estado público de cuenta disponible para derivación.')
    }
    return this.activeAccountState
  }

  private deriveHdOwner(branch: FirmaInputOwner['branch'], index: number): FirmaInputOwner {
    const derived = derivePublicMetadata(this.getAccountStateOrThrow(), branch, index)
    return Object.freeze({
      profileId: this.activeProfileId,
      account: 0,
      address: derived.address,
      hdPath: derived.hdPath,
      branch,
      index,
      publicKeyHex: derived.publicKeyHex
    })
  }

  private getCanonicalReceiveOwner(): FirmaInputOwner {
    this.ensureReady()
    const owner = this.deriveHdOwner('receive', 0)
    if (
      owner.profileId !== this.activeProfileId ||
      owner.account !== 0 ||
      owner.hdPath !== getWalletReceivePath(0, this.activeProfileId)
    ) {
      throw new Error('La identidad pública canónica receive/0 no corresponde al perfil activo.')
    }
    return owner
  }

  private rememberHdOwners(owners: FirmaInputOwner[]): void {
    const byPath = new Map(this.hdAddressCache.map((owner) => [owner.hdPath, owner]))
    for (const owner of owners) {
      byPath.set(owner.hdPath, owner)
    }
    this.hdAddressCache = [...byPath.values()].sort((a, b) => {
      if (a.branch !== b.branch) return a.branch === 'receive' ? -1 : 1
      return a.index - b.index
    })
  }

  private ensureHdAddressCache(gapLimit: number): FirmaInputOwner[] {
    const cachedPaths = new Set(this.hdAddressCache.map((owner) => owner.hdPath))
    const derived: FirmaInputOwner[] = []

    for (let index = 0; index < gapLimit; index += 1) {
      const receivePath = getWalletReceivePath(index, this.activeProfileId)
      const changePath = getWalletChangePath(index, this.activeProfileId)
      if (!cachedPaths.has(receivePath)) derived.push(this.deriveHdOwner('receive', index))
      if (!cachedPaths.has(changePath)) derived.push(this.deriveHdOwner('change', index))
    }
    if (derived.length > 0) this.rememberHdOwners(derived)

    return this.hdAddressCache.filter((owner) => owner.index < gapLimit)
  }

  private deriveAddresses(gapLimit: number) {
    const owners = this.ensureHdAddressCache(gapLimit)
    return {
      owners,
      receive: owners.filter((owner) => owner.branch === 'receive').map((owner) => owner.address),
      change: owners.filter((owner) => owner.branch === 'change').map((owner) => owner.address)
    }
  }

  private async fetchAddressScan(address: string): Promise<AddressScan> {
    const chronik = getChronik()
    const [utxos, history] = await Promise.all([
      chronik.address(address).utxos(),
      chronik.address(address).history(0, 1)
    ])

    return {
      address,
      utxos: utxos.utxos,
      hasHistory: history.txs.length > 0
    }
  }

  private async scanAddresses(gapLimit: number, forceRefresh: boolean): Promise<ScanCache> {
    const now = Date.now()
    if (
      !forceRefresh &&
      this.scanCache?.profileId === this.activeProfileId &&
      this.scanCache.gapLimit >= gapLimit
    ) {
      if (now - this.scanCache.updatedAt < SCAN_CACHE_TTL_MS) {
        return this.scanCache
      }
    }

    if (this.scanPromise && this.scanPromiseGapLimit !== null && this.scanPromiseGapLimit >= gapLimit) {
      return this.scanPromise
    }

    const scanPromise = (async () => {
      const { receive, change, owners } = this.deriveAddresses(gapLimit)

      const scans = await runWithConcurrency(owners, CHRONIK_CONCURRENCY_LIMIT, async (owner) =>
        this.fetchAddressScan(owner.address)
      )

      let spendableXecSats = 0n
      let tokenUtxoSats = 0n
      let totalRmzAtoms = 0n
      let totalFirmaAtoms = 0n
      const discoveredUtxos: ScriptUtxo[] = []

      for (const scan of scans) {
        for (const utxo of scan.utxos) {
          discoveredUtxos.push(utxo)
          if (utxo.token) tokenUtxoSats += utxo.sats
          else spendableXecSats += utxo.sats
          if (utxo.token && utxo.token.tokenId === RMZ_ETOKEN_ID && !utxo.token.isMintBaton) {
            totalRmzAtoms += utxo.token.atoms
          }
          if (
            utxo.token?.tokenId === FIRMA_ALPHA.tokenId &&
            utxo.token.tokenType.protocol === FIRMA_ALPHA.protocol &&
            utxo.token.tokenType.number === FIRMA_ALPHA.tokenType &&
            !utxo.token.isMintBaton
          ) {
            totalFirmaAtoms += utxo.token.atoms
          }
        }
      }

      const [rmzDecimals, firmaDecimals] = await Promise.all([
        this.getRmzDecimals(),
        this.getFirmaAlphaDecimals()
      ])
      const balances: WalletBalance = {
        xec: spendableXecSats,
        tokenUtxoSats,
        tokenUtxoXecFormatted: this.formatXecFromSats(tokenUtxoSats),
        rmzAtoms: totalRmzAtoms,
        rmzFormatted: formatTokenAmount(totalRmzAtoms, rmzDecimals),
        rmzDecimals,
        firmaAtoms: totalFirmaAtoms,
        firmaFormatted: formatTokenAmount(totalFirmaAtoms, firmaDecimals),
        firmaDecimals,
        xecFormatted: this.formatXecFromSats(spendableXecSats)
      }

      const cache: ScanCache = {
        profileId: this.activeProfileId,
        gapLimit,
        updatedAt: Date.now(),
        receive,
        change,
        owners,
        balances,
        tokenAssets: summarizeTokenUtxos(discoveredUtxos)
      }

      this.scanCache = cache
      return cache
    })()

    this.scanPromise = scanPromise
    this.scanPromiseGapLimit = gapLimit
    try {
      return await scanPromise
    } finally {
      this.scanPromise = null
      this.scanPromiseGapLimit = null
    }
  }

  async getBalances(): Promise<WalletBalance> {
    const wallet = this.getWallet()
    await wallet.initialize()

    const gapLimit = Math.max(this.getEffectiveGapLimit(), this.scanCache?.gapLimit ?? 0)

    try {
      const cache = await this.scanAddresses(gapLimit, false)
      return cache.balances
    } catch {
      const fallbackAddress = this.getAddress()
      const [fallbackUtxos] = await Promise.all([
        fallbackAddress
          ? getChronik().address(fallbackAddress).utxos().then((response) => response.utxos).catch(() => [])
          : Promise.resolve([] as ScriptUtxo[])
      ])

      const [rmzDecimals, firmaDecimals] = await Promise.all([
        this.getRmzDecimals(),
        this.getFirmaAlphaDecimals()
      ])
      const rmzAtoms = fallbackUtxos.reduce((total, utxo) => {
        const token = utxo.token
        return token?.tokenId === RMZ_ETOKEN_ID && !token.isMintBaton
          ? total + token.atoms
          : total
      }, 0n)
      const firmaAtoms = fallbackUtxos.reduce((total, utxo) => {
        const token = utxo.token
        return token?.tokenId === FIRMA_ALPHA.tokenId &&
          token.tokenType.protocol === FIRMA_ALPHA.protocol &&
          token.tokenType.number === FIRMA_ALPHA.tokenType &&
          !token.isMintBaton
          ? total + token.atoms
          : total
      }, 0n)
      const { spendableXecSats, tokenUtxoSats } = partitionWalletSats(fallbackUtxos)

      return {
        xec: spendableXecSats,
        tokenUtxoSats,
        tokenUtxoXecFormatted: this.formatXecFromSats(tokenUtxoSats),
        rmzAtoms,
        rmzFormatted: formatTokenAmount(rmzAtoms, rmzDecimals),
        rmzDecimals,
        firmaAtoms,
        firmaFormatted: formatTokenAmount(firmaAtoms, firmaDecimals),
        firmaDecimals,
        xecFormatted: this.formatXecFromSats(spendableXecSats)
      }
    }
  }

  async rescanWallet(options: WalletRescanOptions = {}): Promise<WalletBalance> {
    const wallet = this.getWallet()
    await wallet.initialize()

    const resolvedGapLimit = clampGapLimit(options.gapLimit ?? EXTENDED_GAP_LIMIT)
    if (options.gapLimit) {
      this.persistGapLimit(resolvedGapLimit)
    }

    const startIndex = Math.max(options.startIndex ?? 0, 0)
    const maxAddresses = options.maxAddresses
    const cache = await this.scanAddressesForRescan(resolvedGapLimit, startIndex, maxAddresses)
    return cache.balances
  }

  async sendRMZ(destination: string, amountAtoms: bigint, excludedUtxos: ScriptUtxo[] = []): Promise<string> {
    if (amountAtoms <= 0n) {
      throw new Error('El monto debe ser mayor a cero.')
    }
    const rmzDecimals = await this.getRmzDecimals()
    const balances = await this.getBalances()
    const availableAtoms = balances.rmzAtoms
    if (availableAtoms < amountAtoms) {
      const needStr = formatTokenAmount(amountAtoms, rmzDecimals)
      const availStr = formatTokenAmount(availableAtoms, rmzDecimals)
      throw new Error(`No hay suficientes RMZ. Need: ${needStr} RMZ, Available: ${availStr} RMZ`)
    }

    return this.sendToken(
      RMZ_ETOKEN_ID,
      [{ address: destination, amountAtoms }],
      { expectedProtocol: 'ALP', tokenLabel: 'RMZ', excludedUtxos }
    )
  }

  private getFirmaSpendOwners(): FirmaInputOwner[] {
    const owners = this.scanCache?.owners.length
      ? this.scanCache.owners
      : this.hdAddressCache
    if (owners.length === 0) {
      throw new Error('Actualiza el saldo de la wallet antes de preparar un envío FIRMA.')
    }
    return owners
  }

  private getFirmaChangeOwner(): FirmaInputOwner {
    return this.getCanonicalReceiveOwner()
  }

  private async refreshFirmaOwnedUtxos(owners: FirmaInputOwner[]): Promise<FirmaOwnedUtxo[]> {
    const chronik = getChronik()
    const snapshots = await runWithConcurrency(owners, CHRONIK_CONCURRENCY_LIMIT, async (owner) => {
      const response = await chronik.address(owner.address).utxos()
      return response.utxos.map((utxo) => ({ utxo, owner }))
    })
    return snapshots.flat()
  }

  private deriveSigningMetadataForOwner(owner: FirmaInputOwner): SigningDerivationMetadata {
    if (owner.profileId !== this.activeProfileId || owner.account !== 0) {
      throw new Error('El perfil HD del input FIRMA no coincide con la wallet activa.')
    }
    const expectedPath = owner.branch === 'receive'
      ? getWalletReceivePath(owner.index, owner.profileId)
      : getWalletChangePath(owner.index, owner.profileId)
    if (owner.hdPath !== expectedPath) {
      throw new Error('La ruta HD del input FIRMA no coincide con su rama e índice.')
    }

    const derived = deriveSigningMetadata(
      this.getMnemonicOrThrow(),
      owner.profileId,
      owner.branch,
      owner.index
    )
    const publicKeyHex = derived.publicKeyHex.toLowerCase()
    if (derived.address !== owner.address || publicKeyHex !== owner.publicKeyHex.toLowerCase()) {
      throw new Error(`La clave derivada no corresponde al input FIRMA de ${owner.hdPath}.`)
    }
    return derived
  }

  private deriveHdSignatory(owner: FirmaInputOwner): WalletSignatory {
    const derived = this.deriveSigningMetadataForOwner(owner)
    const publicKeyHex = derived.publicKeyHex.toLowerCase()
    const privateKey = derived.privateKey
    const publicKey = fromHex(publicKeyHex)
    return {
      address: owner.address,
      publicKeyHex,
      publicKey,
      signatory: P2PKHSignatory(privateKey, publicKey, ALL_BIP143)
    }
  }

  private async buildFirmaSendPlan(destination: string, amountAtoms: bigint): Promise<{
    plan: FirmaSendPlan
  }> {
    if (!this.getX402ActiveAccount()) {
      throw new Error('Desbloquea la wallet antes de preparar un envío FIRMA.')
    }

    const chronik = getChronik()
    const owners = this.getFirmaSpendOwners()
    const [tokenInfo, ownedUtxos] = await Promise.all([
      chronik.token(FIRMA_ALPHA.tokenId),
      this.refreshFirmaOwnedUtxos(owners)
    ])
    assertFirmaAlphaTokenInfo(tokenInfo)
    const changeOwner = this.getFirmaChangeOwner()
    return {
      plan: buildFirmaSendPlan({
        changeOwner,
        destination,
        amountAtoms,
        ownedUtxos
      })
    }
  }

  async prepareFirmaSend(destination: string, amountAtoms: bigint): Promise<FirmaSendPreview> {
    return (await this.buildFirmaSendPlan(destination, amountAtoms)).plan.preview
  }

  async sendFirma(preview: FirmaSendPreview): Promise<string> {
    if (preview.tokenId !== FIRMA_ALPHA.tokenId) {
      throw new Error('La previsualización no corresponde al Token ID canónico de Firma Alpha.')
    }

    const fresh = await this.buildFirmaSendPlan(preview.destination, preview.amountAtoms)
    if (fresh.plan.preview.planFingerprint !== preview.planFingerprint) {
      throw new Error('Los UTXOs, la comisión o las salidas cambiaron. Genera una nueva previsualización.')
    }

    const signersByPath = new Map<string, WalletSignatory>()
    for (const { owner } of [...fresh.plan.tokenInputs, ...fresh.plan.xecInputs]) {
      if (!signersByPath.has(owner.hdPath)) {
        signersByPath.set(owner.hdPath, this.deriveHdSignatory(owner))
      }
    }
    const signedTx = this.signTxBuilder(
      createSignedFirmaSendBuilder(fresh.plan, (owner) => {
        const signer = signersByPath.get(owner.hdPath)
        if (!signer || signer.address !== owner.address || signer.publicKeyHex !== owner.publicKeyHex) {
          throw new Error(`No se encontró el signatory correcto para ${owner.hdPath}.`)
        }
        return signer.signatory
      }),
      { feePerKb: FIRMA_SEND_FEE_PER_KB, dustSats: BigInt(XEC_DUST_SATS) }
    )

    const broadcast = await getChronik().broadcastTx(signedTx.ser())
    this.scanCache = null
    await this.getBalances()
    return broadcast.txid
  }

  async sendToken(
    tokenId: string,
    outputs: Array<{ address: string; amountAtoms: bigint }>,
    options: { expectedProtocol?: string; tokenLabel?: string; excludedUtxos?: ScriptUtxo[] } = {}
  ): Promise<string> {
    const wallet = this.getWallet()
    const normalizedTokenId = tokenId.trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(normalizedTokenId)) {
      throw new Error('El tokenId es inválido.')
    }
    if (!outputs.length) {
      throw new Error('Debes indicar al menos un destino para el token.')
    }

    const tokenInfo = await getChronik().token(normalizedTokenId)
    const protocol = tokenInfo?.tokenType?.protocol
    const expectedProtocol = options.expectedProtocol?.trim().toUpperCase()
    if (expectedProtocol && protocol !== expectedProtocol) {
      const label = options.tokenLabel?.trim() || 'El token'
      throw new Error(`${label} no usa protocolo ${expectedProtocol}.`)
    }

    const decimals = tokenInfo?.genesisInfo?.decimals
    if (!Number.isInteger(decimals) || decimals < 0) {
      throw new Error('No pudimos cargar los decimales del token.')
    }

    const normalizedOutputs: SendETokenOutput[] = outputs.map(({ address, amountAtoms }) => {
      if (amountAtoms <= 0n) {
        throw new Error('El monto del token debe ser mayor a cero.')
      }
      return {
        address,
        amount: this.atomsToDisplayNumber(amountAtoms, decimals)
      }
    })

    return this.withTemporarilyExcludedWalletUtxos(options.excludedUtxos ?? [], () =>
      wallet.sendETokens(normalizedTokenId, normalizedOutputs)
    )
  }

  async sendXEC(destination: string, amountInSats: number, message = ''): Promise<string> {
    const wallet = this.getWallet()
    if (amountInSats <= 0) {
      throw new Error('El monto debe ser mayor a cero.')
    }
    const trimmedMessage = message.trim()
    const outputs: SendXecOutput[] = [
      { address: destination, amountSat: amountInSats },
      { address: XEC_TONALLI_TREASURY_ADDRESS, amountSat: TONALLI_SERVICE_FEE_SATS }
    ]
    if (trimmedMessage.length > 0) {
      // El xolo lleva tu mensaje grabado en piedra digital.
      return wallet.sendOpReturn(trimmedMessage, '6d02', outputs, FEE_RATE_SATS_PER_BYTE)
    }
    return wallet.sendXec(outputs)
  }


  async reserveAliasRegistrationUtxos(registration: AliasRegistrationData): Promise<AliasReservedUtxo[]> {
    const rmzAmountAtoms = parseTokenAmount(String(registration.serviceFee.amount), await this.getRmzDecimals())
    const rmzServiceUtxos = await this.selectRmzServiceTransactionUtxos(rmzAmountAtoms)
    const excludedTxids = Array.from(new Set(rmzServiceUtxos.map((utxo) => utxo.outpoint.txid)))
    this.pendingAliasReservationExcludedTxids = excludedTxids
    const plan = await this.buildAliasRegistrationTxPlan(registration, { excludedTxids })
    console.debug('[AliasRegistration] reservedAliasUtxosBeforeRmzTx', this.utxosToDebug(plan.selectedUtxos))
    console.debug('[AliasRegistration] excludedTxids', plan.excludedTxids)
    return plan.selectedUtxos
  }

  async estimateAliasRegistration(registration: AliasRegistrationData): Promise<AliasRegistrationEstimate> {
    const plan = await this.buildAliasRegistrationTxPlan(registration)
    const outputSats = plan.signedTx.outputs.reduce((sum, output) => sum + output.sats, 0n)
    const networkFeeSats = plan.inputSats - outputSats

    return {
      protocolFeeSats: registration.protocolFee.sats,
      networkFeeSats: Number(networkFeeSats),
      totalCostSats: Number(plan.fixedOutputSats + networkFeeSats)
    }
  }

  async buildAliasRegistrationRawTx(
    registration: AliasRegistrationData,
    reservedUtxos?: AliasReservedUtxo[]
  ): Promise<AliasRegistrationRawTxDebug> {
    const plan = await this.buildAliasRegistrationTxPlan(registration, {
      reservedUtxos,
      excludedTxids: reservedUtxos?.length ? this.pendingAliasReservationExcludedTxids : []
    })
    const rawTxHex = plan.signedTx.toHex()
    const computedTxid = plan.signedTx.txid()
    const containsAliasLokadPrefix = rawTxHex.includes('6a042e78656300')
    const selectedUtxos = this.utxosToDebug(plan.selectedUtxos)
    const outputs = plan.signedTx.outputs.map((output, index) => ({
      index,
      sats: output.sats.toString(),
      scriptHex: toHex(output.script.bytecode)
    }))

    return {
      rawTxHex,
      computedTxid,
      containsAliasLokadPrefix,
      selectedUtxos,
      aliasSelectedUtxos: selectedUtxos,
      reservedAliasUtxosBeforeRmzTx: this.utxosToDebug(plan.reservedAliasUtxosBeforeRmzTx),
      rmzTxid: null,
      excludedTxids: plan.excludedTxids,
      usesRmzChangeOutput: plan.usesRmzChangeOutput,
      utxoSelectionSource: plan.utxoSelectionSource,
      outputs,
      protocolFeeAddress: registration.protocolFee.address,
      protocolFeeSats: registration.protocolFee.sats
    }
  }

  async registerAliasTransaction(
    registration: AliasRegistrationData,
    reservedUtxos: AliasReservedUtxo[] = [],
    rmzTxid: string | null = null
  ): Promise<AliasRegistrationBroadcastResult> {
    console.debug('[AliasRegistration] intent', registration)
    const excludedTxids = Array.from(new Set([
      ...(reservedUtxos.length > 0 ? this.pendingAliasReservationExcludedTxids : []),
      ...(rmzTxid ? [rmzTxid] : [])
    ]))
    const plan = await this.buildAliasRegistrationTxPlan(registration, {
      reservedUtxos,
      excludedTxids,
      rmzTxid
    })
    const rawTx = toHex(plan.signedTx.ser())
    const debug: AliasRegistrationDebugInfo = {
      reservedAliasUtxosBeforeRmzTx: this.utxosToDebug(plan.reservedAliasUtxosBeforeRmzTx),
      rmzTxid,
      aliasSelectedUtxos: this.utxosToDebug(plan.selectedUtxos),
      excludedTxids: plan.excludedTxids,
      usesRmzChangeOutput: plan.usesRmzChangeOutput,
      utxoSelectionSource: plan.utxoSelectionSource
    }
    console.debug('[AliasRegistration] debug', debug)
    console.debug('[AliasRegistration] raw alias tx hex', rawTx)

    let txid: string | undefined
    try {
      const result = await getChronik().broadcastTx(rawTx)
      console.debug('[AliasRegistration] broadcast response', result)
      txid = result.txid
    } catch (error) {
      console.error('[AliasRegistration] alias broadcast failed', error)
      throw new Error('Alias transaction broadcast failed.')
    }

    if (!txid) {
      console.error('[AliasRegistration] alias broadcast returned no txid')
      throw new Error('Alias transaction broadcast failed.')
    }

    console.debug('[AliasRegistration] broadcast accepted txid', txid)

    const verified = await this.verifyAliasTxInChronik(txid)
    this.scanCache = null

    if (verified) {
      return { txid, status: 'confirmed_by_chronik', rawTx, debug }
    }

    console.warn('[AliasRegistration] tx broadcast but Chronik not indexed yet', txid)
    return {
      txid,
      status: 'broadcast_pending_index',
      message: 'Alias transaction was broadcast but is not indexed by Chronik yet.',
      rawTx,
      debug
    }
  }

  async registerAliasOnChain(
    registration: AliasRegistrationData,
    reservedUtxos: AliasReservedUtxo[] = [],
    rmzTxid: string | null = null
  ): Promise<AliasRegistrationBroadcastResult> {
    return this.registerAliasTransaction(registration, reservedUtxos, rmzTxid)
  }

  async findAliasForAddress(address: string): Promise<string | null> {
    try {
      const chronik = getChronik()
      if (chronik && typeof chronik.address === 'function') {
        const pageSize = 20
        let page = 0
        let totalPages = 1
        const MAX_PAGES = 50

        while (page < totalPages && page < MAX_PAGES) {
          const res = await chronik.address(address).history(page, pageSize)
          if (typeof res?.numPages === 'number') {
            totalPages = res.numPages
          }
          const txs = Array.isArray(res?.txs) ? res.txs : []
          if (txs.length === 0) {
            break
          }

          for (const tx of txs) {
            const outputs = Array.isArray(tx?.outputs) ? tx.outputs : []
            for (const out of outputs) {
              const script = out?.outputScript
              if (typeof script === 'string') {
                const alias = extractAliasFromOutputScript(script, address)
                if (alias) {
                  return alias
                }
              }
            }
          }

          if (typeof res?.numPages !== 'number' && txs.length < pageSize) {
            break
          }

          page += 1
        }
      }
    } catch {
      // ignore
    }
    return null
  }

  getMnemonic(): string | null {
    return this.decryptedMnemonic
  }

  getKeyInfo(): WalletKeyInfo {
    const xecAddress = this.getAddress()
    return {
      mnemonic: this.getMnemonic(),
      xecAddress,
      address: xecAddress,
      publicKeyHex: this.getPublicKeyHex()
    }
  }

  getPublicKeyHex(): string | null {
    if (!this.wallet || !this.isReady || !this.activeAccountState) return null
    return this.getCanonicalReceiveOwner().publicKeyHex
  }

  getActiveDerivationProfile(): DerivationProfile {
    return getDerivationProfile(this.activeProfileId)
  }

  getActiveDerivationProfileId(): DerivationProfileId {
    return this.activeProfileId
  }

  getOtherDetectedTokenAssets(): readonly DiscoveredTokenAsset[] {
    return Object.freeze(
      (this.scanCache?.tokenAssets ?? []).filter(asset =>
        asset.tokenId !== RMZ_ETOKEN_ID && asset.tokenId !== FIRMA_ALPHA.tokenId
      )
    )
  }

  getAddress(): string | null {
    if (!this.wallet || !this.isReady || !this.activeAccountState) return null
    return this.getCanonicalReceiveOwner().address
  }

  getX402ActiveAccount(): X402WalletAccount | null {
    if (!this.wallet || !this.isReady || !this.decryptedMnemonic || !this.activeAccountState) {
      return null
    }

    const owner = this.getCanonicalReceiveOwner()
    if (!/^(02|03)[0-9a-f]{64}$/.test(owner.publicKeyHex)) {
      return null
    }

    return { address: owner.address, publicKey: owner.publicKeyHex }
  }

  async signX402AuthorizationMessage(message: string): Promise<X402AuthorizationSignature> {
    const account = this.getX402ActiveAccount()
    if (!account) {
      throw new Error('X402_WALLET_UNAVAILABLE')
    }

    try {
      return this.withPrivateKey((privateKey) => ({
        signature: signMsg(message, privateKey),
        publicKey: account.publicKey
      }))
    } catch {
      throw new Error('X402_AUTHORIZATION_SIGNING_FAILED')
    }
  }

  getSignatory(): WalletSignatory {
    if (!this.decryptedMnemonic || !this.activeAccountState) {
      throw new Error('WALLET_LOCKED')
    }
    return this.deriveHdSignatory(this.getCanonicalReceiveOwner())
  }

  getAgoraOneshotAdSignatory(): unknown {
    return this.withPrivateKey((privateKey) => AgoraOneshotAdSignatory(privateKey))
  }

  withPrivateKey<T>(handler: (privateKey: Uint8Array) => T): T {
    if (!this.decryptedMnemonic || !this.activeAccountState) {
      throw new Error('WALLET_LOCKED')
    }
    const derived = this.deriveSigningMetadataForOwner(this.getCanonicalReceiveOwner())
    return handler(derived.privateKey)
  }

  signTxBuilder(builder: TxBuilder, options?: { feePerKb?: bigint; dustSats?: bigint }) {
    return builder.sign(options)
  }

  getHdSpendOwners(): FirmaInputOwner[] {
    if (this.scanCache?.owners.length) {
      return this.scanCache.owners
    }
    if (this.hdAddressCache.length === 0) {
      this.ensureHdAddressCache(this.getEffectiveGapLimit())
    }
    return this.hdAddressCache
  }

  async getHdOwnedUtxos(): Promise<FirmaOwnedUtxo[]> {
    const owners = this.getHdSpendOwners()
    if (owners.length === 0) {
      return []
    }
    return this.refreshFirmaOwnedUtxos(owners)
  }

  getHdSignatoryForOwner(owner: FirmaInputOwner): WalletSignatory {
    return this.deriveHdSignatory(owner)
  }


  private async verifyAliasTxInChronik(txid: string): Promise<boolean> {
    for (let attempt = 1; attempt <= ALIAS_CHRONIK_VERIFY_ATTEMPTS; attempt += 1) {
      console.debug('[AliasRegistration] chronik pending attempt', attempt)
      try {
        await getChronik().tx(txid)
        console.debug('[AliasRegistration] chronik confirmed tx', txid)
        return true
      } catch (error) {
        console.debug('[AliasRegistration] chronik verification pending', error)
        if (attempt < ALIAS_CHRONIK_VERIFY_ATTEMPTS) {
          await delay(ALIAS_CHRONIK_VERIFY_DELAY_MS)
        }
      }
    }

    return false
  }

  private async buildAliasRegistrationTxPlan(
    registration: AliasRegistrationData,
    options: {
      reservedUtxos?: AliasReservedUtxo[]
      excludedTxids?: string[]
      rmzTxid?: string | null
    } = {}
  ): Promise<AliasTxPlan> {
    this.ensureReady()
    const address = this.getAddress()
    if (!address) {
      throw new Error('No se encontro la direccion de la billetera.')
    }

    const signatory = this.getSignatory()
    const addressScript = Script.fromAddress(address)
    const excludedTxids = Array.from(new Set(options.excludedTxids ?? []))
    const excludedTxidSet = new Set(excludedTxids)
    const reservedUtxos = options.reservedUtxos ?? []
    const utxoSelectionSource: AliasRegistrationUtxoSource = reservedUtxos.length > 0
      ? 'reserved_pre_rmz_utxos'
      : 'current_wallet_utxos'

    const candidateUtxos = reservedUtxos.length > 0
      ? reservedUtxos
      : (await getChronik().address(address).utxos()).utxos

    const spendableUtxos = candidateUtxos
      .filter((utxo) => !utxo.token)
      .filter((utxo) => !excludedTxidSet.has(utxo.outpoint.txid))
      .sort((a, b) => (a.sats > b.sats ? -1 : 1))

    if (spendableUtxos.length === 0) {
      throw new Error(reservedUtxos.length > 0 || excludedTxids.length > 0
        ? INDEPENDENT_ALIAS_UTXO_ERROR
        : 'No hay suficiente XEC para cubrir el fee oficial del alias y la tarifa de red.')
    }

    if (!registration.opReturnHex.startsWith('6a042e78656300')) {
      throw new Error('Alias OP_RETURN invalido: se esperaba prefijo 6a042e78656300.')
    }

    const protocolFeeSats = BigInt(registration.protocolFee.sats)
    if (protocolFeeSats <= 0n || !registration.protocolFee.address) {
      throw new Error('Fee oficial del alias invalido.')
    }

    const fixedOutputs = [
      { sats: 0n, script: new Script(fromHex(registration.opReturnHex)) },
      { sats: protocolFeeSats, script: Script.fromAddress(registration.protocolFee.address) }
    ]

    for (let count = 1; count <= spendableUtxos.length; count += 1) {
      const selectedUtxos = spendableUtxos.slice(0, count)
      const usesRmzChangeOutput = Boolean(options.rmzTxid && selectedUtxos.some((utxo) => utxo.outpoint.txid === options.rmzTxid))
      if (usesRmzChangeOutput) {
        throw new Error(RMZ_CHANGE_ALIAS_ABORT_ERROR)
      }

      const inputs = selectedUtxos.map((utxo) => ({
        input: {
          prevOut: utxo.outpoint,
          signData: {
            sats: utxo.sats,
            outputScript: addressScript
          }
        },
        signatory: signatory.signatory
      }))

      const txBuilder = new TxBuilder({
        inputs,
        outputs: [...fixedOutputs, addressScript]
      })

      try {
        const signedTx = txBuilder.sign({
          feePerKb: BigInt(Math.ceil(FEE_RATE_SATS_PER_BYTE * 1000)),
          dustSats: BigInt(XEC_DUST_SATS)
        })
        const inputSats = selectedUtxos.reduce((sum, utxo) => sum + utxo.sats, 0n)
        return {
          signedTx,
          inputSats,
          fixedOutputSats: protocolFeeSats,
          selectedUtxos,
          reservedAliasUtxosBeforeRmzTx: reservedUtxos,
          excludedTxids,
          usesRmzChangeOutput,
          utxoSelectionSource
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (!/insufficient/i.test(message) || count === spendableUtxos.length) {
          if (/insufficient/i.test(message)) {
            throw new Error(reservedUtxos.length > 0 || excludedTxids.length > 0
              ? INDEPENDENT_ALIAS_UTXO_ERROR
              : 'No hay suficiente XEC para cubrir el fee oficial del alias y la tarifa de red.')
          }
          throw err
        }
      }
    }

    throw new Error(reservedUtxos.length > 0 || excludedTxids.length > 0
      ? INDEPENDENT_ALIAS_UTXO_ERROR
      : 'No hay suficiente XEC para cubrir el fee oficial del alias y la tarifa de red.')
  }


  async signMessage(message: string): Promise<string> {
    return this.withPrivateKey((privateKey) => signMsg(message, privateKey))
  }

  async getRmzDecimals(): Promise<number> {
    if (this.rmzDecimals !== null) {
      return this.rmzDecimals
    }
    if (this.rmzDecimalsPromise) {
      return this.rmzDecimalsPromise
    }

    this.rmzDecimalsPromise = (async () => {
      const chronik = getChronik()
      const tokenInfo = await chronik.token(RMZ_ETOKEN_ID)
      const decimals = tokenInfo?.genesisInfo?.decimals
      if (!Number.isInteger(decimals) || decimals < 0) {
        throw new Error('No pudimos cargar los decimales del token RMZ.')
      }
      this.rmzDecimals = decimals
      return decimals
    })()

    try {
      return await this.rmzDecimalsPromise
    } finally {
      this.rmzDecimalsPromise = null
    }
  }

  async getFirmaAlphaDecimals(): Promise<number> {
    return FIRMA_ALPHA.decimals
  }

  private atomsToDisplayNumber(atoms: bigint, decimals: number): number {
    const display = Number(formatTokenAmount(atoms, decimals))
    if (!Number.isFinite(display)) {
      throw new Error('El monto excede el máximo permitido por la billetera.')
    }
    return display
  }

  private formatXecFromSats(sats: bigint): string {
    const isNegative = sats < 0n
    const abs = isNegative ? -sats : sats
    const whole = abs / 100n
    const fraction = abs % 100n
    const formatted = `${whole.toString()}.${fraction.toString().padStart(2, '0')}`
    return isNegative ? `-${formatted}` : formatted
  }

  private async scanAddressesForRescan(
    gapLimit: number,
    startIndex: number,
    maxAddresses?: number
  ): Promise<ScanCache> {
    const now = Date.now()
    const accountState = this.getAccountStateOrThrow()
    const receive: string[] = []
    const change: string[] = []
    const owners: FirmaInputOwner[] = []
    let spendableXecSats = 0n
    let tokenUtxoSats = 0n
    let totalRmzAtoms = 0n
    let totalFirmaAtoms = 0n
    const discoveredUtxos: ScriptUtxo[] = []
    let consecutiveUnused = 0
    let scannedCount = 0
    let index = startIndex

    const scanIndex = async (currentIndex: number) => {
      const receiveDerived = derivePublicMetadata(accountState, 'receive', currentIndex)
      const changeDerived = derivePublicMetadata(accountState, 'change', currentIndex)
      const receiveOwner: FirmaInputOwner = {
        profileId: this.activeProfileId,
        account: 0,
        address: receiveDerived.address,
        hdPath: receiveDerived.hdPath,
        branch: 'receive',
        index: currentIndex,
        publicKeyHex: receiveDerived.publicKeyHex
      }
      const changeOwner: FirmaInputOwner = {
        profileId: this.activeProfileId,
        account: 0,
        address: changeDerived.address,
        hdPath: changeDerived.hdPath,
        branch: 'change',
        index: currentIndex,
        publicKeyHex: changeDerived.publicKeyHex
      }
      const [receiveScan, changeScan] = await Promise.all([
        this.fetchAddressScan(receiveOwner.address),
        this.fetchAddressScan(changeOwner.address)
      ])

      return { receiveOwner, changeOwner, receiveScan, changeScan }
    }

    while (consecutiveUnused < gapLimit) {
      if (maxAddresses !== undefined && scannedCount >= maxAddresses) {
        break
      }

      const batchSize =
        maxAddresses !== undefined
          ? Math.min(CHRONIK_CONCURRENCY_LIMIT, maxAddresses - scannedCount)
          : CHRONIK_CONCURRENCY_LIMIT
      const indices = Array.from({ length: batchSize }, (_, offset) => index + offset)
      const scans = await runWithConcurrency(indices, CHRONIK_CONCURRENCY_LIMIT, scanIndex)

      for (let i = 0; i < scans.length; i += 1) {
        const scan = scans[i]
        receive.push(scan.receiveOwner.address)
        change.push(scan.changeOwner.address)
        owners.push(scan.receiveOwner, scan.changeOwner)
        scannedCount += 1

        let hasActivity = false
        for (const addressScan of [scan.receiveScan, scan.changeScan]) {
          if (addressScan.hasHistory || addressScan.utxos.length > 0) {
            hasActivity = true
          }
          for (const utxo of addressScan.utxos) {
            discoveredUtxos.push(utxo)
            if (utxo.token) tokenUtxoSats += utxo.sats
            else spendableXecSats += utxo.sats
            if (utxo.token && utxo.token.tokenId === RMZ_ETOKEN_ID && !utxo.token.isMintBaton) {
              totalRmzAtoms += utxo.token.atoms
            }
            if (
              utxo.token?.tokenId === FIRMA_ALPHA.tokenId &&
              utxo.token.tokenType.protocol === FIRMA_ALPHA.protocol &&
              utxo.token.tokenType.number === FIRMA_ALPHA.tokenType &&
              !utxo.token.isMintBaton
            ) {
              totalFirmaAtoms += utxo.token.atoms
            }
          }
        }

        if (hasActivity) {
          consecutiveUnused = 0
        } else {
          consecutiveUnused += 1
        }

        if (consecutiveUnused >= gapLimit) {
          break
        }
        if (maxAddresses !== undefined && scannedCount >= maxAddresses) {
          break
        }
      }

      index += scans.length
      if (consecutiveUnused >= gapLimit) {
        break
      }
    }

    const [rmzDecimals, firmaDecimals] = await Promise.all([
      this.getRmzDecimals(),
      this.getFirmaAlphaDecimals()
    ])
    const balances: WalletBalance = {
      xec: spendableXecSats,
      tokenUtxoSats,
      tokenUtxoXecFormatted: this.formatXecFromSats(tokenUtxoSats),
      rmzAtoms: totalRmzAtoms,
      rmzFormatted: formatTokenAmount(totalRmzAtoms, rmzDecimals),
      rmzDecimals,
      firmaAtoms: totalFirmaAtoms,
      firmaFormatted: formatTokenAmount(totalFirmaAtoms, firmaDecimals),
      firmaDecimals,
      xecFormatted: this.formatXecFromSats(spendableXecSats)
    }

    this.rememberHdOwners(owners)

    const cache: ScanCache = {
      profileId: this.activeProfileId,
      gapLimit,
      updatedAt: now,
      receive,
      change,
      owners,
      balances,
      tokenAssets: summarizeTokenUtxos(discoveredUtxos)
    }

    this.scanCache = cache
    this.scanPromise = null
    this.scanPromiseGapLimit = null

    return cache
  }
}

export const xolosWalletService = XolosWalletService.getInstance()
