import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Address, Ecc, fromHex, shaRmd160, signMsg, toHex } from 'ecash-lib'
import { randomTmCommBytes } from './tmCommIds'
import type { TmCommStore } from './tmCommStore'

export type TmCommEphemeralWallet = Readonly<{
  publicKeyHex: string
  address: string
  sign: (message: string) => string
}>

export type TmCommDeterministicWallet = TmCommEphemeralWallet & Readonly<{
  secretHex: string
}>

export type ResolveTmCommOperatorCredentialOptions = Readonly<{
  credentialPath: string
  store: TmCommStore
  maxRetries?: number
  retryDelayMs?: number
}>

export function createTmCommDeterministicWallet(secretHex: string): TmCommDeterministicWallet {
  const trimmed = secretHex.trim()
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error('Invalid secret key hex: must be a 64-character hex string')
  }
  const ecc = new Ecc()
  const secret = fromHex(trimmed)
  if (!ecc.isValidSeckey(secret)) {
    throw new Error('Invalid secret key: not a valid secp256k1 scalar')
  }
  const publicKey = ecc.derivePubkey(secret)
  const address = Address.p2pkh(shaRmd160(publicKey)).address
  const publicKeyHex = toHex(publicKey)
  return Object.freeze({
    secretHex: toHex(secret),
    publicKeyHex,
    address,
    sign(message: string) {
      return signMsg(message, secret)
    }
  })
}

export function createTmCommEphemeralWallet(existingSecretHex?: string): TmCommDeterministicWallet {
  if (typeof existingSecretHex === 'string') {
    return createTmCommDeterministicWallet(existingSecretHex)
  }
  const ecc = new Ecc()
  let secret = randomTmCommBytes(32)
  while (!ecc.isValidSeckey(secret)) {
    secret = randomTmCommBytes(32)
  }
  const secretHex = toHex(secret)
  const publicKey = ecc.derivePubkey(secret)
  const address = Address.p2pkh(shaRmd160(publicKey)).address
  const publicKeyHex = toHex(publicKey)
  return Object.freeze({
    secretHex,
    publicKeyHex,
    address,
    sign(message: string) {
      return signMsg(message, secret)
    }
  })
}

function sleepSync(ms: number): void {
  if (ms <= 0) return
  if (typeof SharedArrayBuffer !== 'undefined' && typeof Atomics !== 'undefined' && typeof Atomics.wait === 'function') {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
      return
    } catch {
      // Fallback to busy-wait
    }
  }
  const end = Date.now() + ms
  while (Date.now() < end) {
    // busy-wait fallback
  }
}

function loadAndValidateWinningCredential(
  credentialPath: string,
  store: TmCommStore,
  maxRetries: number,
  retryDelayMs: number
): TmCommDeterministicWallet {
  let lastError: Error | null = null

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let rawText = ''
    try {
      rawText = readFileSync(credentialPath, 'utf8')
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err))
      if (attempt < maxRetries - 1) {
        sleepSync(retryDelayMs)
        continue
      }
      break
    }

    // An inode created with O_CREAT | O_EXCL may momentarily be empty (0 bytes) while the winner writes
    if (!rawText.trim()) {
      lastError = new Error(`Operator credential file at "${credentialPath}" is empty or incomplete (0 bytes).`)
      if (attempt < maxRetries - 1) {
        sleepSync(retryDelayMs)
        continue
      }
      break
    }

    let raw: unknown
    try {
      raw = JSON.parse(rawText)
    } catch (err: unknown) {
      lastError = new Error(
        `Operator credential file at "${credentialPath}" is corrupt or contains invalid JSON: ${err instanceof Error ? err.message : String(err)}`
      )
      if (attempt < maxRetries - 1) {
        sleepSync(retryDelayMs)
        continue
      }
      break
    }

    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      lastError = new Error(
        `Operator credential file at "${credentialPath}" is corrupt: expected a JSON object.`
      )
      if (attempt < maxRetries - 1) {
        sleepSync(retryDelayMs)
        continue
      }
      break
    }

    const record = raw as Record<string, unknown>
    if (typeof record.secretHex !== 'string') {
      lastError = new Error(
        `Operator credential file at "${credentialPath}" is corrupt: missing required string field "secretHex".`
      )
      if (attempt < maxRetries - 1) {
        sleepSync(retryDelayMs)
        continue
      }
      break
    }

    let wallet: TmCommDeterministicWallet
    try {
      wallet = createTmCommDeterministicWallet(record.secretHex)
    } catch (err: unknown) {
      throw new Error(
        `Operator credential file at "${credentialPath}" contains an invalid secret key: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    if (typeof record.address === 'string' && record.address !== wallet.address) {
      throw new Error(
        `Operator credential file at "${credentialPath}" is corrupt: recorded address (${record.address}) does not match derived address (${wallet.address}).`
      )
    }

    if (
      typeof record.publicKeyHex === 'string' &&
      record.publicKeyHex.toLowerCase() !== wallet.publicKeyHex.toLowerCase()
    ) {
      throw new Error(
        `Operator credential file at "${credentialPath}" is corrupt: recorded publicKeyHex does not match derived publicKeyHex.`
      )
    }

    const existingOperator = store.findOperatorPrincipal()
    if (existingOperator !== null) {
      if (
        existingOperator.walletAddress !== wallet.address ||
        existingOperator.publicKeyHex.toLowerCase() !== wallet.publicKeyHex.toLowerCase()
      ) {
        throw new Error(
          `Operator credential at "${credentialPath}" (address: ${wallet.address}) does not match the stored operator principal in database (address: ${existingOperator.walletAddress}).`
        )
      }
    }

    try {
      chmodSync(credentialPath, 0o600)
    } catch {
      // Best-effort permission setting
    }

    return wallet
  }

  throw new Error(
    `Operator credential file at "${credentialPath}" could not be loaded or validated after ${maxRetries} attempts: ${lastError?.message}`
  )
}

export function resolveTmCommOperatorCredential(
  options: ResolveTmCommOperatorCredentialOptions
): TmCommDeterministicWallet {
  const maxRetries = options.maxRetries ?? 25
  const retryDelayMs = options.retryDelayMs ?? 20
  const existingOperator = options.store.findOperatorPrincipal()
  const credentialExists = existsSync(options.credentialPath)

  if (!credentialExists && existingOperator !== null) {
    throw new Error(
      `Operator credential file is missing at "${options.credentialPath}" but the database already contains an operator principal (${existingOperator.id}, ${existingOperator.walletAddress}). Refusing to regenerate a substitute operator.`
    )
  }

  if (credentialExists) {
    return loadAndValidateWinningCredential(
      options.credentialPath,
      options.store,
      maxRetries,
      retryDelayMs
    )
  }

  const parentDir = dirname(options.credentialPath)
  mkdirSync(parentDir, { recursive: true, mode: 0o700 })

  const wallet = createTmCommEphemeralWallet()
  const payload = {
    notice: 'STAGING ONLY. Fictitious operator wallet. Never a production key.',
    address: wallet.address,
    publicKeyHex: wallet.publicKeyHex,
    secretHex: wallet.secretHex
  }
  const payloadString = `${JSON.stringify(payload, null, 2)}\n`

  try {
    writeFileSync(options.credentialPath, payloadString, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    })
    try {
      chmodSync(options.credentialPath, 0o600)
    } catch {
      // Best-effort permission setting
    }
    return wallet
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code
    if (code === 'EEXIST') {
      return loadAndValidateWinningCredential(
        options.credentialPath,
        options.store,
        maxRetries,
        retryDelayMs
      )
    }
    throw err
  }
}

export function cookieValue(setCookieHeaders: readonly string[], cookieName: string): string | null {
  for (const header of setCookieHeaders) {
    const match = new RegExp(`^${cookieName}=([^;]+)`).exec(header)
    if (match) return match[1]
  }
  return null
}
