export type SendXecOutput = {
  address: string
  amountSat: number
}

export type SendETokenOutput = {
  address: string
  amount: number
}

export type WalletInfo = {
  mnemonic?: string
  xecAddress?: string
  publicKey?: string
  privateKey?: string
}

export type ETokenBalance = {
  balance?: {
    display?: number
  }
}

export type WalletOptions = {
  hdPath: string
  chronikUrls: string[]
  enableDonations: boolean
}

export interface MinimalXecWallet {
  walletInfoPromise: Promise<WalletInfo>
  walletInfo?: WalletInfo
  mnemonic?: string
  isInitialized?: boolean
  initialize: () => Promise<boolean>
  getXecBalance: () => Promise<number>
  getETokenBalance: (params: { tokenId: string }) => Promise<number | ETokenBalance>
  sendETokens: (tokenId: string, outputs: SendETokenOutput[]) => Promise<string>
  sendXec: (outputs: SendXecOutput[]) => Promise<string>
  sendOpReturn: (
    message: string,
    prefixHex: string,
    outputs: SendXecOutput[],
    satsPerByte?: number
  ) => Promise<string>
}

export type MinimalXECWalletConstructor = new (
  mnemonic?: string,
  options?: WalletOptions
) => MinimalXecWallet
