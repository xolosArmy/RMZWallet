declare module 'ecash-agora' {
  import type { Script } from 'ecash-lib'

  export interface AgoraPartialParams {
    offeredAtoms: bigint
    priceNanoSatsPerAtom: bigint
    makerPk: Uint8Array
    minAcceptedAtoms: bigint
    tokenId: string
    tokenType: number
    tokenProtocol: 'SLP' | 'ALP'
    enforcedLockTime: number
    dustSats?: bigint
    minAtomsScaleFactor?: bigint
    minPriceInteger?: bigint
    minScaleRatio?: bigint
  }

  export class AgoraPartial {
    static COVENANT_VARIANT: string
    static approximateParams(params: AgoraPartialParams): AgoraPartial
    constructor(params: {
      truncAtoms: bigint
      numAtomsTruncBytes: number
      atomsScaleFactor: bigint
      scaledTruncAtomsPerTruncSat: bigint
      numSatsTruncBytes: number
      makerPk: Uint8Array
      minAcceptedScaledTruncAtoms: bigint
      tokenId: string
      tokenType: number
      tokenProtocol: 'SLP' | 'ALP'
      scriptLen: number
      enforcedLockTime: number
      dustSats: bigint
    })
    adPushdata(): Uint8Array
    offeredAtoms(): bigint
    minAcceptedAtoms(): bigint
    script(): { bytecode: Uint8Array }
    prepareAcceptedAtoms(atoms: bigint): bigint
    askedSats(atoms: bigint): bigint
    priceNanoSatsPerAtom(atoms: bigint): bigint
    updateScriptLen(): void
    tokenType: number
    tokenId: string
    dustSats: bigint
  }

  export class AgoraOneshot {
    static COVENANT_VARIANT: string
    constructor(params: { enforcedOutputs: { sats: bigint; script: Script }[]; cancelPk: Uint8Array })
    script(): { bytecode: Uint8Array }
    adScript(): { bytecode: Uint8Array }
    askedSats(): bigint
    enforcedOutputs: { sats: bigint; script: Script }[]
  }

  export type AgoraOfferVariant =
    | { type: 'ONESHOT'; params: AgoraOneshot }
    | { type: 'PARTIAL'; params: AgoraPartial }

  export type AgoraOfferStatus = 'OPEN' | 'TAKEN' | 'CANCELED'

  export const AGORA_LOKAD_ID: Uint8Array

  export class Agora {
    constructor(chronik: unknown, dustSats?: bigint)
    activeOffersByTokenId(tokenId: string): Promise<AgoraOffer[]>
  }

  export const AgoraOneshotAdSignatory: (sk: Uint8Array) => unknown
  export const parseAgoraTx: (tx: unknown) => {
    type: 'ONESHOT'
    params: AgoraOneshot
    outpoint: { txid: string; outIdx: number }
    txBuilderInput: unknown
    spentBy?: unknown
  } | undefined

  export class AgoraOffer {
    constructor(params: {
      variant: AgoraOfferVariant
      outpoint: { txid: string; outIdx: number }
      txBuilderInput: unknown
      token: {
        tokenId: string
        atoms: bigint
        tokenType: { number: number; protocol: 'SLP' | 'ALP' | 'UNKNOWN' }
      }
      status: AgoraOfferStatus
      takenInfo?: unknown
    })
    variant: AgoraOfferVariant
    status: AgoraOfferStatus
    askedSats(atoms?: bigint): bigint
    acceptFeeSats(params: Record<string, unknown>): bigint
    acceptTx(params: Record<string, unknown>): { ser: () => Uint8Array }
    token: {
      tokenId: string
      atoms: bigint
      tokenType: { number: number; protocol: 'SLP' | 'ALP' | 'UNKNOWN' }
    }
    outpoint: { txid: string; outIdx: number }
  }
}
