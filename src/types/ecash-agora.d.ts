declare module 'ecash-agora' {
  export type AgoraPartialParams = Record<string, unknown>
  export type AgoraOfferParams = Record<string, unknown>

  export const AGORA_LOKAD_ID: Uint8Array

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

  export class AgoraOffer {
    constructor(params: AgoraOfferParams)
    askedSats(atoms: bigint): bigint
    acceptFeeSats(params: Record<string, unknown>): bigint
    acceptTx(params: Record<string, unknown>): { ser: () => Uint8Array }
  }
}
