export const TONALLI_PREFIX_HEX = '6d02'

const OP_RETURN_HEX = '6a'
const MAX_SCRIPT_BYTES = 10000

const isHex = (value: string) => /^[0-9a-f]+$/i.test(value)

const readLittleEndian = (hex: string) => {
  const bytes = hex.match(/.{1,2}/g)
  if (!bytes) return null
  return parseInt(bytes.reverse().join(''), 16)
}

const decodePrintableAscii = (hex: string) => {
  if (!hex || hex.length % 2 !== 0 || !isHex(hex)) return ''
  let result = ''
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.slice(i, i + 2), 16)
    if (Number.isNaN(byte)) return ''
    if (byte >= 32 && byte <= 126) {
      result += String.fromCharCode(byte)
    }
  }
  return result
}

export const decodeOpReturn = (scriptHex: string): { prefix?: string; message?: string } | null => {
  if (!scriptHex) return null
  const script = scriptHex.toLowerCase()
  if (!script.startsWith(OP_RETURN_HEX)) return null
  if (script.length % 2 !== 0 || !isHex(script)) return { prefix: undefined, message: undefined }
  if (script.length / 2 > MAX_SCRIPT_BYTES) return { prefix: undefined, message: undefined }

  let cursor = 2
  const payloads: string[] = []

  while (cursor < script.length) {
    if (cursor + 2 > script.length) return { prefix: undefined, message: undefined }
    const opcode = parseInt(script.slice(cursor, cursor + 2), 16)
    if (Number.isNaN(opcode)) return { prefix: undefined, message: undefined }
    cursor += 2

    let pushLength: number | null = null
    if (opcode <= 75) {
      pushLength = opcode
    } else if (opcode === 76) {
      if (cursor + 2 > script.length) return { prefix: undefined, message: undefined }
      pushLength = parseInt(script.slice(cursor, cursor + 2), 16)
      cursor += 2
    } else if (opcode === 77) {
      if (cursor + 4 > script.length) return { prefix: undefined, message: undefined }
      const lengthHex = script.slice(cursor, cursor + 4)
      pushLength = readLittleEndian(lengthHex)
      cursor += 4
    } else if (opcode === 78) {
      if (cursor + 8 > script.length) return { prefix: undefined, message: undefined }
      const lengthHex = script.slice(cursor, cursor + 8)
      pushLength = readLittleEndian(lengthHex)
      cursor += 8
    } else {
      return { prefix: undefined, message: undefined }
    }

    if (pushLength === null || pushLength < 0) return { prefix: undefined, message: undefined }
    const dataLength = pushLength * 2
    if (cursor + dataLength > script.length) return { prefix: undefined, message: undefined }
    if (dataLength > 0) {
      payloads.push(script.slice(cursor, cursor + dataLength))
    }
    cursor += dataLength
  }

  const payloadHex = payloads.join('')
  if (!payloadHex) return { prefix: undefined, message: undefined }

  let prefix: string | undefined
  let messageHex = payloadHex

  if (payloadHex.startsWith(TONALLI_PREFIX_HEX)) {
    prefix = TONALLI_PREFIX_HEX
    messageHex = payloadHex.slice(TONALLI_PREFIX_HEX.length)
  }

  const message = decodePrintableAscii(messageHex)
  return { prefix, message: message || undefined }
}
