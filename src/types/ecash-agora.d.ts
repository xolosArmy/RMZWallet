declare module 'ecash-agora' {
  import type { Script } from 'ecash-lib'
  export type AgoraPartialParams = Record<string, unknown>
  export type AgoraOfferParams = Record<string, unknown>

  export const AGORA_LOKAD_ID: Uint8Array

  export class Agora {
    constructor(chronik: unknown, dustSats?: bigint)
    activeOffersByTokenId: (tokenId: string) => Promise<AgoraOffer[]>
  }

  export class AgoraPartial {
    static COVENANT_VARIANT: string
    static approximateParams(params: AgoraPartialParams): AgoraPartial
    constructor(params: AgoraPartialParams)
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
    constructor(params: Record<string, unknown>)
    script(): { bytecode: Uint8Array }
    adScript(): { bytecode: Uint8Array }
    askedSats(): bigint
    enforcedOutputs: { sats: bigint; script: Script }[]
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
    constructor(params: AgoraOfferParams)
    askedSats(atoms?: bigint): bigint
    acceptFeeSats(params: Record<string, unknown>): bigint
    acceptTx(params: Record<string, unknown>): { ser: () => Uint8Array }
    token: { atoms: bigint }
    outpoint: { txid: string; outIdx: number }
  }
}
