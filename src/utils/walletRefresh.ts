import { NFT_RESCAN_STORAGE_KEY } from '../config/nfts'

export const WALLET_REFRESH_EVENT = 'rmzwallet:refresh'

export type WalletRefreshDetail = {
  refreshUtxos?: boolean
  refreshBalances?: boolean
  refreshNfts?: boolean
  reason?: string
  txid?: string
}

export const triggerWalletRefresh = (detail: WalletRefreshDetail = {}) => {
  if (typeof window === 'undefined') return
  if (detail.refreshNfts) {
    localStorage.setItem(NFT_RESCAN_STORAGE_KEY, Date.now().toString())
  }
  window.dispatchEvent(new CustomEvent(WALLET_REFRESH_EVENT, { detail }))
}
