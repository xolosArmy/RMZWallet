declare module 'ecash-agora' {
  import type { ScriptUtxo } from 'chronik-client'
  import type { Script } from 'ecash-lib'
  export type AgoraPartialParams = Record<string, unknown>
  export type AgoraOfferParams = Record<string, unknown>

  export const AGORA_LOKAD_ID: Uint8Array
  export const DUMMY_KEYPAIR: { sk: Uint8Array; pk: Uint8Array }
  export const getAgoraPartialAcceptFuelInputs: (
    offer: AgoraOffer,
    utxos: ScriptUtxo[],
    acceptedAtoms: bigint,
    feePerKb?: bigint
  ) => ScriptUtxo[]

  export class Agora {
    constructor(chronik: unknown, dustSats?: bigint)
    activeOffersByTokenId: (tokenId: string) => Promise<AgoraOffer[]>
    selectParams(params: AgoraPartialParams): Promise<AgoraPartial>
  }

  export class AgoraPartial {
    static COVENANT_VARIANT: string
    static approximateParams(params: AgoraPartialParams): AgoraPartial
    constructor(params: AgoraPartialParams)
    adPushdata(): Uint8Array
    adScript(): { bytecode: Uint8Array }
    offeredAtoms(): bigint
    minAcceptedAtoms(): bigint
    script(): { bytecode: Uint8Array }
    prepareAcceptedAtoms(atoms: bigint): bigint
    preventUnacceptableRemainder(atoms: bigint): void
    askedSats(atoms: bigint): bigint
    priceNanoSatsPerAtom(atoms: bigint): bigint
    updateScriptLen(): void
    tokenType: number
    tokenId: string
    tokenProtocol: 'ALP' | 'SLP'
    makerPk: Uint8Array
    dustSats: bigint
    enforcedLockTime: number
  }

  export class AgoraOneshot {
    static COVENANT_VARIANT: string
    constructor(params: Record<string, unknown>)
    script(): { bytecode: Uint8Array }
    adScript(): { bytecode: Uint8Array }
    askedSats(): bigint
    enforcedOutputs: { sats: bigint; script: Script }[]
  }

  export const AgoraPartialAdSignatory: (sk: Uint8Array) => unknown
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
    variant: { type: 'PARTIAL'; params: AgoraPartial } | { type: 'ONESHOT'; params: AgoraOneshot }
    token: {
      tokenId: string
      tokenType: { protocol: string; number: number }
      atoms: bigint
      isMintBaton: boolean
    }
    outpoint: { txid: string; outIdx: number }
    txBuilderInput: unknown
    status: 'OPEN' | 'TAKEN' | 'CANCELED'
  }
}
