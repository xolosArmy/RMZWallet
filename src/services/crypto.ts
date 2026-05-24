import CryptoJS from 'crypto-js'

const CRYPTO_VERSION = 2
const PBKDF2_ITERATIONS = 300_000
const PBKDF2_HASH = 'SHA-256'
const SALT_BYTES = 16
const IV_BYTES = 12
const KEY_BYTES = 32

type EncryptedContainerV2 = {
  v: 2
  crypto: {
    kdf: {
      name: 'PBKDF2'
      hash: 'SHA-256'
      iterations: number
      salt: string
    }
    cipher: {
      name: 'AES-GCM'
      iv: string
    }
    ciphertext: string
  }
}

export type DecryptPasswordResult = {
  plainText: string
  migratedCipherText: string | null
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

const assertCryptoAvailable = () => {
  if (!globalThis.crypto?.subtle || typeof globalThis.crypto.getRandomValues !== 'function') {
    throw new Error('Web Crypto API no está disponible en este entorno.')
  }
}

const toBufferSource = (bytes: Uint8Array) => new Uint8Array(bytes)

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

const isEncryptedContainerV2 = (value: unknown): value is EncryptedContainerV2 => {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<EncryptedContainerV2>
  return (
    candidate.v === CRYPTO_VERSION &&
    typeof candidate.crypto?.kdf?.salt === 'string' &&
    typeof candidate.crypto?.cipher?.iv === 'string' &&
    typeof candidate.crypto?.ciphertext === 'string'
  )
}

const deriveAesKey = async (password: string, salt: Uint8Array, iterations: number) => {
  assertCryptoAvailable()
  const baseKey = await crypto.subtle.importKey('raw', textEncoder.encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: PBKDF2_HASH,
      iterations,
      salt: toBufferSource(salt)
    },
    baseKey,
    { name: 'AES-GCM', length: KEY_BYTES * 8 },
    false,
    ['encrypt', 'decrypt']
  )
}

const decryptLegacyCryptoJs = (cipherText: string, password: string): string => {
  const key = CryptoJS.SHA256(password).toString()
  const bytes = CryptoJS.AES.decrypt(cipherText, key)
  const decrypted = bytes.toString(CryptoJS.enc.Utf8)

  if (!decrypted) {
    throw new Error('No se pudo descifrar la semilla. Password incorrecto o datos corruptos.')
  }

  return decrypted
}

export async function encryptWithPassword(plainText: string, password: string): Promise<string> {
  assertCryptoAvailable()
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const key = await deriveAesKey(password, salt, PBKDF2_ITERATIONS)
  const cipherBuffer = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: toBufferSource(iv)
    },
    key,
    textEncoder.encode(plainText)
  )

  const payload: EncryptedContainerV2 = {
    v: CRYPTO_VERSION,
    crypto: {
      kdf: {
        name: 'PBKDF2',
        hash: PBKDF2_HASH,
        iterations: PBKDF2_ITERATIONS,
        salt: bytesToBase64(salt)
      },
      cipher: {
        name: 'AES-GCM',
        iv: bytesToBase64(iv)
      },
      ciphertext: bytesToBase64(new Uint8Array(cipherBuffer))
    }
  }

  return JSON.stringify(payload)
}

export async function decryptWithPassword(cipherText: string, password: string): Promise<DecryptPasswordResult> {
  let parsed: unknown

  try {
    parsed = JSON.parse(cipherText)
  } catch {
    parsed = null
  }

  if (!isEncryptedContainerV2(parsed)) {
    const plainText = decryptLegacyCryptoJs(cipherText, password)
    return {
      plainText,
      migratedCipherText: await encryptWithPassword(plainText, password)
    }
  }

  try {
    const salt = base64ToBytes(parsed.crypto.kdf.salt)
    const iv = base64ToBytes(parsed.crypto.cipher.iv)
    const ciphertext = base64ToBytes(parsed.crypto.ciphertext)
    const key = await deriveAesKey(password, salt, parsed.crypto.kdf.iterations)
    const plainBuffer = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toBufferSource(iv)
      },
      key,
      toBufferSource(ciphertext)
    )

    return {
      plainText: textDecoder.decode(plainBuffer),
      migratedCipherText: null
    }
  } catch {
    throw new Error('No se pudo descifrar la semilla. Password incorrecto o datos corruptos.')
  }
}
