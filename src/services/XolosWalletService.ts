import * as MinimalXecWalletModule from 'minimal-xec-wallet'
import { fromHex, signMsg } from 'ecash-lib'
import type { ScriptUtxo } from 'chronik-client'
import { RMZ_ETOKEN_ID } from '../config/rmzToken'
import { FEE_RATE_SATS_PER_BYTE, TONALLI_SERVICE_FEE_SATS, XEC_TONALLI_TREASURY_ADDRESS } from '../config/xecFees'
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
  'https://chronik.e.cash',
  'https://chronik.xolosarmy.xyz'
]
const DERIVATION_PATH = "m/44'/899'/0'/0/0"
const STORAGE_KEY_MNEMONIC = 'xoloswallet_encrypted_mnemonic'
const STORAGE_KEY_GAP_LIMIT = 'xoloswallet_gap_limit'
const SCAN_CACHE_TTL_MS = 30000
const CHRONIK_CONCURRENCY_LIMIT = 4

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
  privateKeyHex: string | null
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
    const mnemonic = decryptWithPassword(this.encryptedMnemonic, password)
    await this.restoreFromMnemonic(mnemonic)
    this.decryptedMnemonic = mnemonic
    this.scanCache = null
    this.scanPromise = null
    this.scanPromiseGapLimit = null
  }

  async unlockEncryptedWallet(password: string): Promise<void> {
    if (!this.encryptedMnemonic) {
      throw new Error('No existe una semilla cifrada en este dispositivo.')
    }
    const mnemonic = decryptWithPassword(this.encryptedMnemonic, password)
    this.decryptedMnemonic = mnemonic
  }

  encryptAndStoreMnemonic(password: string): void {
    let mnemonic = this.decryptedMnemonic

    const walletMnemonic = this.wallet?.mnemonic || this.wallet?.walletInfo?.mnemonic
    if (!mnemonic && walletMnemonic) {
      mnemonic = walletMnemonic
      this.decryptedMnemonic = mnemonic
    }

    if (!mnemonic) {
      throw new Error('No hay semilla en memoria para cifrar. Vuelve a iniciar el onboarding y el respaldo.')
    }

    const cipherText = encryptWithPassword(mnemonic, password)
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
    const wallet = this.getWallet()
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

    const amount = this.atomsToDisplayNumber(amountAtoms, rmzDecimals)
    const outputs: SendETokenOutput[] = [{ address: destination, amount }]
    return wallet.sendETokens(RMZ_ETOKEN_ID, outputs)
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

  getMnemonic(): string | null {
    return this.decryptedMnemonic
  }

  getKeyInfo(): WalletKeyInfo {
    const xecAddress = this.getAddress()
    return {
      mnemonic: this.getMnemonic(),
      xecAddress,
      address: xecAddress,
      publicKeyHex: this.getPublicKeyHex(),
      privateKeyHex: this.getPrivateKeyHex()
    }
  }

  getPublicKeyHex(): string | null {
    return this.wallet?.walletInfo?.publicKey || null
  }

  getPrivateKeyHex(): string | null {
    return this.wallet?.walletInfo?.privateKey || null
  }

  getAddress(): string | null {
    return this.wallet?.walletInfo?.xecAddress || null
  }

  async signMessage(message: string): Promise<string> {
    const privKeyHex = this.getPrivateKeyHex()
    if (!privKeyHex) {
      throw new Error('WALLET_LOCKED')
    }
    return signMsg(message, fromHex(privKeyHex))
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
