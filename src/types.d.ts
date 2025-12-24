declare module 'minimal-xec-wallet' {
  export interface WalletInfo {
    mnemonic?: string
    xecAddress?: string
    publicKey?: string
    privateKey?: string
  }

  export class MinimalXECWallet {
    constructor(mnemonic?: string, options?: Record<string, unknown>)
    walletInfoPromise: Promise<WalletInfo>
    walletInfo?: WalletInfo
    mnemonic?: string
    isInitialized: boolean
    initialize: () => Promise<boolean>
    getXecBalance: (...args: unknown[]) => Promise<number>
    getETokenBalance: (...args: unknown[]) => Promise<unknown>
    sendETokens: (...args: unknown[]) => Promise<string>
    sendXec: (...args: unknown[]) => Promise<string>
  }
}

declare module 'crypto-js' {
  const content: {
    SHA256: (value: string) => { toString: () => string }
    AES: {
      encrypt: (plainText: string, key: string) => { toString: () => string }
      decrypt: (cipherText: string, key: string) => { toString: (encoder: unknown) => string }
    }
    enc: {
      Utf8: unknown
    }
  }
  export default content
}
