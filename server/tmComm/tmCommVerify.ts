import { createHash } from 'node:crypto'
import { Address, fromHex, shaRmd160, toHex, verifyMsg } from 'ecash-lib'

const COMPRESSED_PUBKEY = /^(02|03)[0-9a-f]{64}$/

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function digestEquals(leftHex: string, rightHex: string): boolean {
  if (leftHex.length !== rightHex.length || leftHex.length === 0) return false
  let diff = 0
  for (let index = 0; index < leftHex.length; index += 1) {
    diff |= leftHex.charCodeAt(index) ^ rightHex.charCodeAt(index)
  }
  return diff === 0
}

export function normalizeWalletAddress(address: string): string {
  const trimmed = address.trim()
  const parsed = Address.fromCashAddress(trimmed)
  if (parsed.type !== 'p2pkh' || parsed.prefix !== 'ecash') {
    throw new Error('TM-COMM accepts only ecash P2PKH addresses.')
  }
  return parsed.address
}

export function publicKeyBindsAddress(publicKeyHex: string, address: string): boolean {
  if (!COMPRESSED_PUBKEY.test(publicKeyHex.toLowerCase())) return false
  try {
    const pubkeyHash = toHex(shaRmd160(fromHex(publicKeyHex.toLowerCase())))
    const addressHash = Address.fromCashAddress(address).hash
    return pubkeyHash === addressHash
  } catch {
    return false
  }
}

export function verifyTmCommWalletSignature(input: {
  canonicalMessage: string
  signature: string
  address: string
  publicKeyHex: string
}): boolean {
  if (!publicKeyBindsAddress(input.publicKeyHex, input.address)) return false
  return verifyMsg(input.canonicalMessage, input.signature, input.address)
}
