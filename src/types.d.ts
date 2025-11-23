declare module 'minimal-xec-wallet' {
  export class MinimalXECWallet {
    constructor(mnemonic?: string, options?: Record<string, unknown>)
    walletInfoPromise: Promise<any>
    walletInfo: any
    isInitialized: boolean
    initialize: () => Promise<boolean>
    getXecBalance: (...args: any[]) => Promise<number>
    getETokenBalance: (...args: any[]) => Promise<any>
    sendETokens: (...args: any[]) => Promise<string>
    sendXec: (...args: any[]) => Promise<string>
  }
}

declare module 'crypto-js' {
  const content: any
  export default content
}
