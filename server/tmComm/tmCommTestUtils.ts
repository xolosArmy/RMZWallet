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

export function resolveTmCommOperatorCredential(
  options: ResolveTmCommOperatorCredentialOptions
): TmCommDeterministicWallet {
  const credentialExists = existsSync(options.credentialPath)
  const existingOperator = options.store.findOperatorPrincipal()

  if (!credentialExists) {
    if (existingOperator !== null) {
      throw new Error(
        `Operator credential file is missing at "${options.credentialPath}" but the database already contains an operator principal (${existingOperator.id}, ${existingOperator.walletAddress}). Refusing to regenerate a substitute operator.`
      )
    }

    const wallet = createTmCommEphemeralWallet()
    const parentDir = dirname(options.credentialPath)
    mkdirSync(parentDir, { recursive: true, mode: 0o700 })
    const payload = {
      notice: 'STAGING ONLY. Fictitious operator wallet. Never a production key.',
      address: wallet.address,
      publicKeyHex: wallet.publicKeyHex,
      secretHex: wallet.secretHex
    }
    writeFileSync(options.credentialPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
    try {
      chmodSync(options.credentialPath, 0o600)
    } catch {
      // Best-effort permission setting
    }
    return wallet
  }

  let raw: unknown
  try {
    const rawText = readFileSync(options.credentialPath, 'utf8')
    raw = JSON.parse(rawText)
  } catch (err) {
    throw new Error(
      `Operator credential file at "${options.credentialPath}" is corrupt or contains invalid JSON: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(
      `Operator credential file at "${options.credentialPath}" is corrupt: expected a JSON object.`
    )
  }

  const record = raw as Record<string, unknown>
  if (typeof record.secretHex !== 'string') {
    throw new Error(
      `Operator credential file at "${options.credentialPath}" is corrupt: missing required string field "secretHex".`
    )
  }

  let wallet: TmCommDeterministicWallet
  try {
    wallet = createTmCommDeterministicWallet(record.secretHex)
  } catch (err) {
    throw new Error(
      `Operator credential file at "${options.credentialPath}" contains an invalid secret key: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  if (typeof record.address === 'string' && record.address !== wallet.address) {
    throw new Error(
      `Operator credential file at "${options.credentialPath}" is corrupt: recorded address (${record.address}) does not match derived address (${wallet.address}).`
    )
  }

  if (
    typeof record.publicKeyHex === 'string' &&
    record.publicKeyHex.toLowerCase() !== wallet.publicKeyHex.toLowerCase()
  ) {
    throw new Error(
      `Operator credential file at "${options.credentialPath}" is corrupt: recorded publicKeyHex does not match derived publicKeyHex.`
    )
  }

  if (existingOperator !== null) {
    if (
      existingOperator.walletAddress !== wallet.address ||
      existingOperator.publicKeyHex.toLowerCase() !== wallet.publicKeyHex.toLowerCase()
    ) {
      throw new Error(
        `Operator credential at "${options.credentialPath}" (address: ${wallet.address}) does not match the stored operator principal in database (address: ${existingOperator.walletAddress}).`
      )
    }
  }

  try {
    chmodSync(options.credentialPath, 0o600)
  } catch {
    // Best-effort permission setting
  }

  return wallet
}

export function cookieValue(setCookieHeaders: readonly string[], cookieName: string): string | null {
  for (const header of setCookieHeaders) {
    const match = new RegExp(`^${cookieName}=([^;]+)`).exec(header)
    if (match) return match[1]
  }
  return null
}
