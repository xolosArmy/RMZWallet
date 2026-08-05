export const TM1_DRAFT_02_LOKAD_ID_HEX = '544d4d00'
export const TM1_DRAFT_02_VERSION = 0x01
export const TM1_DRAFT_02_POST_EVENT_TYPE = 0x01
export const TM1_DRAFT_02_PROTOCOL_MAX_EVENT_DATA_BYTES = 212
export const TM1_DRAFT_02_WALLET_MAX_EVENT_DATA_BYTES = 80
export const TM1_DRAFT_02_MAX_SCRIPT_BYTES = 223

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

  const eventDataBytes = new TextEncoder().encode(options.eventData)
  if (eventDataBytes.length === 0) {
    throw new Tm1Draft02EncodingError('EMPTY_EVENT_DATA', 'El mensaje TM1 no puede estar vacío.')
  }
  if (eventDataBytes.length > TM1_DRAFT_02_WALLET_MAX_EVENT_DATA_BYTES) {
    throw new Tm1Draft02EncodingError(
      'EVENT_DATA_TOO_LARGE',
      `El mensaje TM1 usa ${eventDataBytes.length} bytes UTF-8; la vista previa de Tonalli Wallet permite hasta ${TM1_DRAFT_02_WALLET_MAX_EVENT_DATA_BYTES}.`
    )
  }

  const lokadIdBytes = hexToBytes(TM1_DRAFT_02_LOKAD_ID_HEX)
  const envelopeBytes = new Uint8Array(3 + eventDataBytes.length)
  envelopeBytes[0] = TM1_DRAFT_02_VERSION
  envelopeBytes[1] = TM1_DRAFT_02_POST_EVENT_TYPE
  envelopeBytes[2] = authorInputIndex
  envelopeBytes.set(eventDataBytes, 3)

  const scriptBytes = concatBytes(
    new Uint8Array([0x6a]),
    encodeMinimalPush(lokadIdBytes),
    encodeMinimalPush(envelopeBytes)
  )

  if (scriptBytes.length > TM1_DRAFT_02_MAX_SCRIPT_BYTES) {
    throw new Tm1Draft02EncodingError(
      'SCRIPT_TOO_LARGE',
      `El script TM1 produce ${scriptBytes.length} bytes; el límite de compatibilidad es ${TM1_DRAFT_02_MAX_SCRIPT_BYTES}.`
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
    eventDataByteLength: eventDataBytes.length,
    envelopeByteLength: envelopeBytes.length,
    scriptByteLength: scriptBytes.length,
    envelopeHex: bytesToHex(envelopeBytes),
    scriptHex: bytesToHex(scriptBytes)
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

function encodeMinimalPush(bytes: Uint8Array): Uint8Array {
  if (bytes.length <= 75) {
    return concatBytes(new Uint8Array([bytes.length]), bytes)
  }
  if (bytes.length <= 0xff) {
    return concatBytes(new Uint8Array([0x4c, bytes.length]), bytes)
  }
  throw new Error('La vista previa TM1 solo admite pushes de hasta 255 bytes.')
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error('Hexadecimal TM1 interno inválido.')
  }
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0)
  const output = new Uint8Array(totalLength)
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
