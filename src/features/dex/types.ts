import type { AgoraOffer } from 'ecash-agora'

export type ActiveDexOffer = {
  offerId: string
  txid: string
  outIdx: number
  tokenId: string
  tokenAtoms: bigint
  askedSats: bigint
  variantType: 'PARTIAL' | 'ONESHOT'
  rawOffer: AgoraOffer
  kind: 'rmz'
}
