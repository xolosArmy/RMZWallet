import * as MinimalXecWalletModule from 'minimal-xec-wallet'
import { ALL_BIP143, P2PKHSignatory, Script, TxBuilder, fromHex, signMsg, toHex } from 'ecash-lib'
import { AgoraOneshotAdSignatory } from 'ecash-agora'
import type { ScriptUtxo } from 'chronik-client'
import type { AliasRegistrationData } from '@xolosarmy/tonalli-core'
import { RMZ_ETOKEN_ID } from '../config/rmzToken'
import {
  FEE_RATE_SATS_PER_BYTE,
  TONALLI_SERVICE_FEE_SATS,
  XEC_DUST_SATS,
  XEC_TONALLI_TREASURY_ADDRESS
} from '../config/xecFees'
import { getChronik } from './ChronikClient'
import { decryptWithPassword, encryptWithPassword } from './crypto'
import { formatTokenAmount, parseTokenAmount } from '../utils/tokenFormat'
import type {
  MinimalXecWallet,
  MinimalXECWalletConstructor,
  SendETokenOutput,
  SendXecOutput,
  WalletInfo
} from '../types/wallet'

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
  'https://chronik.xolosarmy.xyz',
  'https://chronik.e.cash'
]
const DERIVATION_PATH = "m/44'/899'/0'/0/0"
const STORAGE_KEY_MNEMONIC = 'xoloswallet_encrypted_mnemonic'
const STORAGE_KEY_GAP_LIMIT = 'xoloswallet_gap_limit'
const SCAN_CACHE_TTL_MS = 30000
const CHRONIK_CONCURRENCY_LIMIT = 4
const ALIAS_CHRONIK_VERIFY_ATTEMPTS = 20
const ALIAS_CHRONIK_VERIFY_DELAY_MS = 3000

export const DEFAULT_GAP_LIMIT = 20
export const EXTENDED_GAP_LIMIT = 100

type AddressScan = {
  address: string
  utxos: ScriptUtxo[]
  hasHistory: boolean
}

type ScanCache = {
  gapLimit: number
  updatedAt: number
  receive: string[]
  change: string[]
  balances: WalletBalance
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

const resolveBasePath = (path: string) => {
  const segments = path.split('/')
  if (segments.length < 3) return path
  return segments.slice(0, -2).join('/')
}

export const WALLET_DERIVATION_PATH = DERIVATION_PATH

export const getWalletReceivePath = (index: number) => {
  const basePath = resolveBasePath(DERIVATION_PATH)
  return `${basePath}/0/${index}`
}

export const getWalletChangePath = (index: number) => {
  const basePath = resolveBasePath(DERIVATION_PATH)
  return `${basePath}/1/${index}`
}

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
  xec: bigint // satoshis
  rmzAtoms: bigint
  rmzFormatted: string
  rmzDecimals: number
  xecFormatted: string // XEC con 2 decimales
}

export type WalletRescanOptions = {
  gapLimit?: number
  startIndex?: number
  maxAddresses?: number
}

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
}

export type AliasRegistrationRawTxDebug = {
  rawTxHex: string
  computedTxid: string
  containsAliasLokadPrefix: boolean
  selectedUtxos: Array<{
    txid: string
    outIdx: number
    sats: string
  }>
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
}

export class XolosWalletService {
  private static instance: XolosWalletService
  private wallet: MinimalXecWallet | null = null
  private isReady = false
  private encryptedMnemonic: string | null = null
  private decryptedMnemonic: string | null = null
  private scanCache: ScanCache | null = null
  private scanPromise: Promise<ScanCache> | null = null
  private scanPromiseGapLimit: number | null = null
  private rmzDecimals: number | null = null
  private rmzDecimalsPromise: Promise<number> | null = null

  private constructor() {
    this.encryptedMnemonic = typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEY_MNEMONIC) : null
  }

  static getInstance(): XolosWalletService {
    if (!XolosWalletService.instance) {
      XolosWalletService.instance = new XolosWalletService()
    }
    return XolosWalletService.instance
  }

  private buildWallet(mnemonic?: string) {
    this.wallet = new MinimalXECWalletResolved(mnemonic, {
      hdPath: DERIVATION_PATH,
      chronikUrls: CHRONIK_ENDPOINTS,
      enableDonations: false
    })
    this.scanCache = null
    this.scanPromise = null
    this.scanPromiseGapLimit = null
    return this.wallet
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

  async createNewWallet(): Promise<string> {
    this.buildWallet()
    const wallet = this.wallet as MinimalXecWallet
    const walletInfo: WalletInfo = await wallet.walletInfoPromise
    await wallet.initialize()
    this.isReady = true
    this.decryptedMnemonic = walletInfo?.mnemonic || null
    this.encryptedMnemonic = null
    this.scanCache = null
    this.scanPromise = null
    this.scanPromiseGapLimit = null
    return this.decryptedMnemonic || ''
  }

  async restoreFromMnemonic(mnemonic: string): Promise<void> {
    if (!mnemonic || mnemonic.trim().split(' ').length < 12) {
      throw new Error('La frase semilla es inválida.')
    }
    this.buildWallet(mnemonic.trim())
    const wallet = this.wallet as MinimalXecWallet
    await wallet.walletInfoPromise
    await wallet.initialize()
    this.isReady = true
    this.decryptedMnemonic = mnemonic.trim()
    this.scanCache = null
    this.scanPromise = null
    this.scanPromiseGapLimit = null
  }

  async loadFromStorage(password: string): Promise<void> {
    if (!this.encryptedMnemonic) {
      throw new Error('No existe una semilla cifrada en este dispositivo.')
    }
    const { plainText, migratedCipherText } = await decryptWithPassword(this.encryptedMnemonic, password)
    if (migratedCipherText) {
      localStorage.setItem(STORAGE_KEY_MNEMONIC, migratedCipherText)
      this.encryptedMnemonic = migratedCipherText
    }
    await this.restoreFromMnemonic(plainText)
    this.decryptedMnemonic = plainText
    this.scanCache = null
    this.scanPromise = null
    this.scanPromiseGapLimit = null
  }

  async unlockEncryptedWallet(password: string): Promise<void> {
    if (!this.encryptedMnemonic) {
      throw new Error('No existe una semilla cifrada en este dispositivo.')
    }
    const { plainText, migratedCipherText } = await decryptWithPassword(this.encryptedMnemonic, password)
    if (migratedCipherText) {
      localStorage.setItem(STORAGE_KEY_MNEMONIC, migratedCipherText)
      this.encryptedMnemonic = migratedCipherText
    }
    this.decryptedMnemonic = plainText
  }

  async encryptAndStoreMnemonic(password: string): Promise<void> {
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
  }

  clearStoredWallet(): void {
    localStorage.removeItem(STORAGE_KEY_MNEMONIC)
    this.encryptedMnemonic = null
    this.decryptedMnemonic = null
    this.wallet = null
    this.isReady = false
    this.scanCache = null
    this.scanPromise = null
    this.scanPromiseGapLimit = null
    this.rmzDecimals = null
    this.rmzDecimalsPromise = null
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

  private getKeyDerivation() {
    const wallet = this.getWallet() as MinimalXecWallet & {
      keyDerivation?: { deriveFromMnemonic: (mnemonic: string, hdPath?: string) => { address: string } }
    }
    const keyDerivation = wallet.keyDerivation
    if (!keyDerivation || typeof keyDerivation.deriveFromMnemonic !== 'function') {
      throw new Error('No se encontró el derivador de llaves de la billetera.')
    }
    return keyDerivation
  }

  private deriveAddresses(gapLimit: number) {
    const mnemonic = this.getMnemonicOrThrow()
    const keyDerivation = this.getKeyDerivation()
    const basePath = resolveBasePath(DERIVATION_PATH)
    const receive: string[] = []
    const change: string[] = []

    for (let index = 0; index < gapLimit; index += 1) {
      const receivePath = `${basePath}/0/${index}`
      const changePath = `${basePath}/1/${index}`
      receive.push(keyDerivation.deriveFromMnemonic(mnemonic, receivePath).address)
      change.push(keyDerivation.deriveFromMnemonic(mnemonic, changePath).address)
    }

    return { receive, change }
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
    if (!forceRefresh && this.scanCache && this.scanCache.gapLimit >= gapLimit) {
      if (now - this.scanCache.updatedAt < SCAN_CACHE_TTL_MS) {
        return this.scanCache
      }
    }

    if (this.scanPromise && this.scanPromiseGapLimit !== null && this.scanPromiseGapLimit >= gapLimit) {
      return this.scanPromise
    }

    const scanPromise = (async () => {
      const { receive, change } = this.deriveAddresses(gapLimit)
      const allAddresses = [...receive, ...change]

      const scans = await runWithConcurrency(allAddresses, CHRONIK_CONCURRENCY_LIMIT, async (address) =>
        this.fetchAddressScan(address)
      )

      let totalSats = 0n
      let totalRmzAtoms = 0n

      for (const scan of scans) {
        for (const utxo of scan.utxos) {
          totalSats += utxo.sats
          if (utxo.token && utxo.token.tokenId === RMZ_ETOKEN_ID && !utxo.token.isMintBaton) {
            totalRmzAtoms += utxo.token.atoms
          }
        }
      }

      const rmzDecimals = await this.getRmzDecimals()
      const xec = totalSats
      const balances: WalletBalance = {
        xec,
        rmzAtoms: totalRmzAtoms,
        rmzFormatted: formatTokenAmount(totalRmzAtoms, rmzDecimals),
        rmzDecimals,
        xecFormatted: this.formatXecFromSats(totalSats)
      }

      const cache: ScanCache = {
        gapLimit,
        updatedAt: Date.now(),
        receive,
        change,
        balances
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
      const [xecBalance, rmzBalanceObj] = await Promise.all([
        wallet.getXecBalance(),
        wallet.getETokenBalance({ tokenId: RMZ_ETOKEN_ID })
      ])

      const rmzDecimals = await this.getRmzDecimals()
      const rmzDisplayValue =
        typeof rmzBalanceObj === 'number'
          ? rmzBalanceObj
          : rmzBalanceObj.balance?.display || 0
      const rmzDisplayString = (() => {
        const raw = rmzDisplayValue.toString()
        if (/e/i.test(raw)) {
          return rmzDisplayValue.toFixed(rmzDecimals)
        }
        return raw
      })()
      const rmzAtoms = parseTokenAmount(rmzDisplayString, rmzDecimals)

      const xecInSats = BigInt(Math.round((xecBalance || 0) * 100))

      return {
        xec: xecInSats,
        rmzAtoms,
        rmzFormatted: formatTokenAmount(rmzAtoms, rmzDecimals),
        rmzDecimals,
        xecFormatted: this.formatXecFromSats(xecInSats)
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

  async sendRMZ(destination: string, amountAtoms: bigint): Promise<string> {
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
      { expectedProtocol: 'ALP', tokenLabel: 'RMZ' }
    )
  }

  async sendToken(
    tokenId: string,
    outputs: Array<{ address: string; amountAtoms: bigint }>,
    options: { expectedProtocol?: string; tokenLabel?: string } = {}
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

    return wallet.sendETokens(normalizedTokenId, normalizedOutputs)
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

  async buildAliasRegistrationRawTx(registration: AliasRegistrationData): Promise<AliasRegistrationRawTxDebug> {
    const plan = await this.buildAliasRegistrationTxPlan(registration)
    const rawTxHex = plan.signedTx.toHex()
    const computedTxid = plan.signedTx.txid()
    const containsAliasLokadPrefix = rawTxHex.includes('6a042e78656300')
    const selectedUtxos = plan.selectedUtxos.map((utxo) => ({
      txid: utxo.outpoint.txid,
      outIdx: utxo.outpoint.outIdx,
      sats: utxo.sats.toString()
    }))
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
      outputs,
      protocolFeeAddress: registration.protocolFee.address,
      protocolFeeSats: registration.protocolFee.sats
    }
  }

  async registerAliasTransaction(registration: AliasRegistrationData): Promise<AliasRegistrationBroadcastResult> {
    console.debug('[AliasRegistration] intent', registration)
    const plan = await this.buildAliasRegistrationTxPlan(registration)
    const rawTx = toHex(plan.signedTx.ser())
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
      return { txid, status: 'confirmed_by_chronik', rawTx }
    }

    console.warn('[AliasRegistration] tx broadcast but Chronik not indexed yet', txid)
    return {
      txid,
      status: 'broadcast_pending_index',
      message: 'Alias transaction was broadcast but is not indexed by Chronik yet.',
      rawTx
    }
  }

  async registerAliasOnChain(registration: AliasRegistrationData): Promise<AliasRegistrationBroadcastResult> {
    return this.registerAliasTransaction(registration)
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
    return this.wallet?.walletInfo?.publicKey || null
  }

  getAddress(): string | null {
    return this.wallet?.walletInfo?.xecAddress || null
  }

  getSignatory(): WalletSignatory {
    const privateKeyHex = this.wallet?.walletInfo?.privateKey || null
    const publicKeyHex = this.wallet?.walletInfo?.publicKey || null
    const address = this.wallet?.walletInfo?.xecAddress || null

    if (!privateKeyHex || !publicKeyHex || !address) {
      throw new Error('WALLET_LOCKED')
    }

    const privateKey = fromHex(privateKeyHex)
    const publicKey = fromHex(publicKeyHex)

    return {
      address,
      publicKeyHex,
      publicKey,
      signatory: P2PKHSignatory(privateKey, publicKey, ALL_BIP143)
    }
  }

  getAgoraOneshotAdSignatory(): unknown {
    const privateKeyHex = this.wallet?.walletInfo?.privateKey || null
    if (!privateKeyHex) {
      throw new Error('WALLET_LOCKED')
    }
    return AgoraOneshotAdSignatory(fromHex(privateKeyHex))
  }

  withPrivateKey<T>(handler: (privateKey: Uint8Array) => T): T {
    const privateKeyHex = this.wallet?.walletInfo?.privateKey || null
    if (!privateKeyHex) {
      throw new Error('WALLET_LOCKED')
    }
    return handler(fromHex(privateKeyHex))
  }

  signTxBuilder(builder: TxBuilder, options?: { feePerKb?: bigint; dustSats?: bigint }) {
    return builder.sign(options)
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

  private async buildAliasRegistrationTxPlan(registration: AliasRegistrationData): Promise<AliasTxPlan> {
    this.ensureReady()
    const address = this.getAddress()
    if (!address) {
      throw new Error('No se encontro la direccion de la billetera.')
    }

    const signatory = this.getSignatory()
    const addressScript = Script.fromAddress(address)
    const utxoResponse = await getChronik().address(address).utxos()
    const spendableUtxos = utxoResponse.utxos
      .filter((utxo) => !utxo.token)
      .sort((a, b) => (a.sats > b.sats ? -1 : 1))

    if (spendableUtxos.length === 0) {
      throw new Error('No hay suficiente XEC para cubrir el fee oficial del alias y la tarifa de red.')
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
          selectedUtxos
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (!/insufficient/i.test(message) || count === spendableUtxos.length) {
          if (/insufficient/i.test(message)) {
            throw new Error('No hay suficiente XEC para cubrir el fee oficial del alias y la tarifa de red.')
          }
          throw err
        }
      }
    }

    throw new Error('No hay suficiente XEC para cubrir el fee oficial del alias y la tarifa de red.')
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
    const mnemonic = this.getMnemonicOrThrow()
    const keyDerivation = this.getKeyDerivation()
    const basePath = resolveBasePath(DERIVATION_PATH)
    const receive: string[] = []
    const change: string[] = []
    let totalSats = 0n
    let totalRmzAtoms = 0n
    let consecutiveUnused = 0
    let scannedCount = 0
    let index = startIndex

    const scanIndex = async (currentIndex: number) => {
      const receivePath = `${basePath}/0/${currentIndex}`
      const changePath = `${basePath}/1/${currentIndex}`
      const receiveAddress = keyDerivation.deriveFromMnemonic(mnemonic, receivePath).address
      const changeAddress = keyDerivation.deriveFromMnemonic(mnemonic, changePath).address
      const [receiveScan, changeScan] = await Promise.all([
        this.fetchAddressScan(receiveAddress),
        this.fetchAddressScan(changeAddress)
      ])

      return { receiveAddress, changeAddress, receiveScan, changeScan }
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
        receive.push(scan.receiveAddress)
        change.push(scan.changeAddress)
        scannedCount += 1

        let hasActivity = false
        for (const addressScan of [scan.receiveScan, scan.changeScan]) {
          if (addressScan.hasHistory || addressScan.utxos.length > 0) {
            hasActivity = true
          }
          for (const utxo of addressScan.utxos) {
            totalSats += utxo.sats
            if (utxo.token && utxo.token.tokenId === RMZ_ETOKEN_ID && !utxo.token.isMintBaton) {
              totalRmzAtoms += utxo.token.atoms
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

    const rmzDecimals = await this.getRmzDecimals()
    const balances: WalletBalance = {
      xec: totalSats,
      rmzAtoms: totalRmzAtoms,
      rmzFormatted: formatTokenAmount(totalRmzAtoms, rmzDecimals),
      rmzDecimals,
      xecFormatted: this.formatXecFromSats(totalSats)
    }

    const cache: ScanCache = {
      gapLimit,
      updatedAt: now,
      receive,
      change,
      balances
    }

    this.scanCache = cache
    this.scanPromise = null
    this.scanPromiseGapLimit = null

    return cache
  }
}

export const xolosWalletService = XolosWalletService.getInstance()
