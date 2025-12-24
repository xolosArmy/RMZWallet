import * as MinimalXecWalletModule from 'minimal-xec-wallet'
import type { MinimalXECWallet as MinimalXECWalletInstance } from 'minimal-xec-wallet'
import { RMZ_ETOKEN_ID } from '../config/rmzToken'
import { decryptWithPassword, encryptWithPassword } from './crypto'

const CHRONIK_ENDPOINTS = ['https://chronik.e.cash', 'https://chronik.paybutton.org']
const DERIVATION_PATH = "m/44'/899'/0'/0/0"
const STORAGE_KEY_MNEMONIC = 'xoloswallet_encrypted_mnemonic'

type MinimalXECWalletCtor = new (mnemonic?: string, options?: Record<string, unknown>) => MinimalXECWalletInstance

type MinimalXecWalletModuleType = {
  MinimalXECWallet?: MinimalXECWalletCtor
  default?: MinimalXECWalletCtor
}

// The package ships a UMD/CJS build without an ES default export; grab whatever
// is available (named export, default from CJS transform, or browser global).
const MinimalXECWallet: MinimalXECWalletCtor | undefined =
  (MinimalXecWalletModule as MinimalXecWalletModuleType).MinimalXECWallet ??
  (MinimalXecWalletModule as MinimalXecWalletModuleType).default ??
  (typeof window !== 'undefined'
    ? ((window as Window & { MinimalXecWallet?: MinimalXECWalletCtor }).MinimalXecWallet as
        | MinimalXECWalletCtor
        | undefined)
    : undefined)

if (!MinimalXECWallet) {
  throw new Error('MinimalXECWallet constructor not found (module export mismatch)')
}

const MinimalXECWalletResolved = MinimalXECWallet as MinimalXECWalletCtor

export interface WalletBalance {
  xec: number // satoshis
  rmz: number // tokens RMZ
  xecFormatted: string // XEC con 2 decimales
}

class XolosWalletService {
  private static instance: XolosWalletService
  private wallet: MinimalXECWalletInstance | null = null
  private isReady = false
  private encryptedMnemonic: string | null = null
  private decryptedMnemonic: string | null = null

  private constructor() {
    this.encryptedMnemonic = typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEY_MNEMONIC) : null
  }

  static getInstance(): XolosWalletService {
    if (!XolosWalletService.instance) {
      XolosWalletService.instance = new XolosWalletService()
    }
    return XolosWalletService.instance
  }

  private buildWallet(mnemonic?: string): MinimalXECWalletInstance {
    this.wallet = new MinimalXECWalletResolved(mnemonic, {
      hdPath: DERIVATION_PATH,
      chronikUrls: CHRONIK_ENDPOINTS,
      enableDonations: false
    })
    return this.wallet
  }

  private ensureReady() {
    if (!this.wallet || !this.isReady) {
      throw new Error('La billetera no está inicializada aún.')
    }
  }

  async createNewWallet(): Promise<string> {
    const wallet = this.buildWallet()
    const walletInfo = await wallet.walletInfoPromise
    await wallet.initialize()
    this.isReady = true
    this.decryptedMnemonic = walletInfo?.mnemonic || null
    this.encryptedMnemonic = null
    return this.decryptedMnemonic || ''
  }

  async restoreFromMnemonic(mnemonic: string): Promise<void> {
    if (!mnemonic || mnemonic.trim().split(' ').length < 12) {
      throw new Error('La frase semilla es inválida.')
    }
    const wallet = this.buildWallet(mnemonic.trim())
    await wallet.walletInfoPromise
    await wallet.initialize()
    this.isReady = true
    this.decryptedMnemonic = mnemonic.trim()
  }

  async loadFromStorage(password: string): Promise<void> {
    if (!this.encryptedMnemonic) {
      throw new Error('No existe una semilla cifrada en este dispositivo.')
    }
    const mnemonic = decryptWithPassword(this.encryptedMnemonic, password)
    await this.restoreFromMnemonic(mnemonic)
    this.decryptedMnemonic = mnemonic
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
  }

  async getBalances(): Promise<WalletBalance> {
    this.ensureReady()
    const wallet = this.wallet!
    await wallet.initialize()

    type RmzBalanceResponse = number | { balance?: { display?: number } }

    const [xecBalance, rmzBalanceObj] = await Promise.all([
      wallet.getXecBalance(),
      wallet.getETokenBalance({ tokenId: RMZ_ETOKEN_ID }) as Promise<RmzBalanceResponse>
    ])

    const rmz =
      typeof rmzBalanceObj === 'number'
        ? rmzBalanceObj
        : rmzBalanceObj?.balance?.display || 0

    const xecInSats = Math.round((xecBalance || 0) * 100) // XEC tiene 2 decimales, satoshis = XEC * 100

    return {
      xec: xecInSats,
      rmz,
      xecFormatted: (xecBalance || 0).toFixed(2)
    }
  }

  async sendRMZ(destination: string, amount: number): Promise<string> {
    this.ensureReady()
    const wallet = this.wallet!
    if (amount <= 0) {
      throw new Error('El monto debe ser mayor a cero.')
    }
    return wallet.sendETokens(RMZ_ETOKEN_ID, [{ address: destination, amount }])
  }

  async sendXEC(destination: string, amountInSats: number): Promise<string> {
    this.ensureReady()
    const wallet = this.wallet!
    if (amountInSats <= 0) {
      throw new Error('El monto debe ser mayor a cero.')
    }
    return wallet.sendXec([{ address: destination, amountSat: amountInSats }])
  }

  getMnemonic(): string | null {
    return this.decryptedMnemonic
  }

  getKeyInfo(): { mnemonic: string | null; xecAddress: string | null } {
    return {
      mnemonic: this.getMnemonic(),
      xecAddress: this.getAddress()
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
}

export const xolosWalletService = XolosWalletService.getInstance()
