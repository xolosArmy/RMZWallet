import CryptoJS from 'crypto-js'

const PBKDF2_ITERATIONS = 300000
const PBKDF2_SALT_BYTES = 16
const AES_GCM_IV_BYTES = 12
const AES_GCM_KEY_LENGTH = 256

export type EncryptionEnvelopeV2 = {
  v: 2
  kdf: {
    name: 'PBKDF2'
    hash: 'SHA-256'
    iterations: number
    saltB64: string
  }
  cipher: {
    name: 'AES-GCM'
    ivB64: string
    ciphertextB64: string
  }
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

const getWebCrypto = (): Crypto => {
  if (typeof globalThis === 'undefined' || !globalThis.crypto?.subtle) {
    throw new Error('Web Crypto API no está disponible en este entorno.')
  }

  return globalThis.crypto
}

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

const base64ToBytes = (value: string): Uint8Array => {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes
}

const parseEnvelope = (cipherText: string): EncryptionEnvelopeV2 | null => {
  try {
    const parsed = JSON.parse(cipherText) as Partial<EncryptionEnvelopeV2>
    if (
      parsed?.v !== 2 ||
      parsed.kdf?.name !== 'PBKDF2' ||
      parsed.kdf?.hash !== 'SHA-256' ||
      typeof parsed.kdf?.iterations !== 'number' ||
      typeof parsed.kdf?.saltB64 !== 'string' ||
      parsed.cipher?.name !== 'AES-GCM' ||
      typeof parsed.cipher?.ivB64 !== 'string' ||
      typeof parsed.cipher?.ciphertextB64 !== 'string'
    ) {
      return null
    }

    return parsed as EncryptionEnvelopeV2
  } catch {
    return null
  }
}

const deriveAesKey = async (
  password: string,
  salt: Uint8Array,
  iterations: number,
  usages: KeyUsage[]
): Promise<CryptoKey> => {
  const cryptoApi = getWebCrypto()
  const passwordBytes = textEncoder.encode(password)
  const passwordKey = await cryptoApi.subtle.importKey('raw', toArrayBuffer(passwordBytes), 'PBKDF2', false, ['deriveKey'])

  return cryptoApi.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: toArrayBuffer(salt),
      iterations
    },
    passwordKey,
    {
      name: 'AES-GCM',
      length: AES_GCM_KEY_LENGTH
    },
    false,
    usages
  )
}

const decryptLegacyWithCryptoJs = (cipherText: string, password: string): string => {
  const key = CryptoJS.SHA256(password).toString()
  const bytes = CryptoJS.AES.decrypt(cipherText, key)
  const decrypted = bytes.toString(CryptoJS.enc.Utf8)

  if (!decrypted) {
    throw new Error('No se pudo descifrar la semilla. Password incorrecto o datos corruptos.')
  }

  return decrypted
}

export function isEncryptedPayloadV2(cipherText: string): boolean {
  return parseEnvelope(cipherText) !== null
}

export async function encryptWithPassword(plainText: string, password: string): Promise<string> {
  const cryptoApi = getWebCrypto()
  const salt = cryptoApi.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES))
  const iv = cryptoApi.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES))
  const key = await deriveAesKey(password, salt, PBKDF2_ITERATIONS, ['encrypt'])
  const plaintextBytes = textEncoder.encode(plainText)
  const ciphertext = await cryptoApi.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(iv)
    },
    key,
    toArrayBuffer(plaintextBytes)
  )

  const envelope: EncryptionEnvelopeV2 = {
    v: 2,
    kdf: {
      name: 'PBKDF2',
      hash: 'SHA-256',
      iterations: PBKDF2_ITERATIONS,
      saltB64: bytesToBase64(salt)
    },
    cipher: {
      name: 'AES-GCM',
      ivB64: bytesToBase64(iv),
      ciphertextB64: bytesToBase64(new Uint8Array(ciphertext))
    }
  }

  return JSON.stringify(envelope)
}

export async function decryptWithPassword(cipherText: string, password: string): Promise<string> {
  const envelope = parseEnvelope(cipherText)
  if (!envelope) {
    return decryptLegacyWithCryptoJs(cipherText, password)
  }

  try {
    const iv = base64ToBytes(envelope.cipher.ivB64)
    const salt = base64ToBytes(envelope.kdf.saltB64)
    const ciphertext = base64ToBytes(envelope.cipher.ciphertextB64)
    const key = await deriveAesKey(password, salt, envelope.kdf.iterations, ['decrypt'])
    const decrypted = await getWebCrypto().subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toArrayBuffer(iv)
      },
      key,
      toArrayBuffer(ciphertext)
    )

    return textDecoder.decode(decrypted)
  } catch {
    throw new Error('No se pudo descifrar la semilla. Password incorrecto o datos corruptos.')
  }
}
