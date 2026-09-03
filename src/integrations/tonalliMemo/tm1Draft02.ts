import {
  MAX_TM1_EVENT_DATA_BYTES,
  MAX_TM1_SCRIPT_BYTES,
  TM1_LOKAD_ID_HEX,
  TM1_POST_EVENT_TYPE,
  TM1_VERSION,
  encodeTm1Post,
  utf8ByteLength
} from '@xolosarmy/tonalli-memo-protocol'

export const TM1_DRAFT_02_LOKAD_ID_HEX = TM1_LOKAD_ID_HEX
export const TM1_DRAFT_02_VERSION = TM1_VERSION
export const TM1_DRAFT_02_POST_EVENT_TYPE = TM1_POST_EVENT_TYPE
export const TM1_DRAFT_02_PROTOCOL_MAX_EVENT_DATA_BYTES = MAX_TM1_EVENT_DATA_BYTES
export const TM1_DRAFT_02_WALLET_MAX_EVENT_DATA_BYTES = 80
export const TM1_DRAFT_02_MAX_SCRIPT_BYTES = MAX_TM1_SCRIPT_BYTES

export type Tm1Draft02EncodingErrorCode =
  | 'INVALID_AUTHOR_INPUT_INDEX'
  | 'EMPTY_EVENT_DATA'
  | 'EVENT_DATA_TOO_LARGE'
  | 'SCRIPT_TOO_LARGE'

export class Tm1Draft02EncodingError extends Error {
  readonly code: Tm1Draft02EncodingErrorCode

  constructor(code: Tm1Draft02EncodingErrorCode, message: string) {
    super(message)
    this.name = 'Tm1Draft02EncodingError'
    this.code = code
  }
}

export type Tm1Draft02PostPreview = {
  readonly protocol: 'TM1'
  readonly draft: '0.2'
  readonly lokadIdHex: typeof TM1_DRAFT_02_LOKAD_ID_HEX
  readonly version: typeof TM1_DRAFT_02_VERSION
  readonly eventType: typeof TM1_DRAFT_02_POST_EVENT_TYPE
  readonly authorInputIndex: number
  readonly eventData: string
  readonly eventDataByteLength: number
  readonly envelopeByteLength: number
  readonly scriptByteLength: number
  readonly envelopeHex: string
  readonly scriptHex: string
}

export type EncodeTm1Draft02PostOptions = {
  readonly eventData: string
  readonly authorInputIndex?: number
}

export function encodeTm1Draft02Post(options: EncodeTm1Draft02PostOptions): Tm1Draft02PostPreview {
  const authorInputIndex = options.authorInputIndex ?? 0
  validateAuthorInputIndex(authorInputIndex)

  const eventDataLength = utf8ByteLength(options.eventData)
  if (eventDataLength === 0) {
    throw new Tm1Draft02EncodingError('EMPTY_EVENT_DATA', 'El mensaje TM1 no puede estar vacío.')
  }
  if (eventDataLength > TM1_DRAFT_02_WALLET_MAX_EVENT_DATA_BYTES) {
    throw new Tm1Draft02EncodingError(
      'EVENT_DATA_TOO_LARGE',
      `El mensaje TM1 usa ${eventDataLength} bytes UTF-8; la vista previa de Tonalli Wallet permite hasta ${TM1_DRAFT_02_WALLET_MAX_EVENT_DATA_BYTES}.`
    )
  }

  let encoded: ReturnType<typeof encodeTm1Post>
  try {
    encoded = encodeTm1Post({
      eventData: options.eventData,
      authorInputIndex
    })
  } catch (error) {
    throw new Tm1Draft02EncodingError('SCRIPT_TOO_LARGE', (error as Error).message)
  }

  if (encoded.script.length > TM1_DRAFT_02_MAX_SCRIPT_BYTES) {
    throw new Tm1Draft02EncodingError(
      'SCRIPT_TOO_LARGE',
      `El script TM1 produce ${encoded.script.length} bytes; el límite de compatibilidad es ${TM1_DRAFT_02_MAX_SCRIPT_BYTES}.`
    )
  }

  return {
    protocol: 'TM1',
    draft: '0.2',
    lokadIdHex: TM1_DRAFT_02_LOKAD_ID_HEX,
    version: TM1_DRAFT_02_VERSION,
    eventType: TM1_DRAFT_02_POST_EVENT_TYPE,
    authorInputIndex,
    eventData: options.eventData,
    eventDataByteLength: eventDataLength,
    envelopeByteLength: encoded.envelopeByteLength,
    scriptByteLength: encoded.scriptByteLength,
    envelopeHex: encoded.envelopeHex,
    scriptHex: encoded.scriptHex
  }
}

function validateAuthorInputIndex(authorInputIndex: number): void {
  if (!Number.isSafeInteger(authorInputIndex) || authorInputIndex < 0 || authorInputIndex > 0xff) {
    throw new Tm1Draft02EncodingError(
      'INVALID_AUTHOR_INPUT_INDEX',
      'El índice del input autor debe ser un entero entre 0 y 255.'
    )
  }
}
