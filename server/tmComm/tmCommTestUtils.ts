import { Address, Ecc, shaRmd160, signMsg, toHex } from 'ecash-lib'
import { randomTmCommBytes } from './tmCommIds'

export type TmCommEphemeralWallet = Readonly<{
  publicKeyHex: string
  address: string
  sign: (message: string) => string
}>

export function createTmCommEphemeralWallet(): TmCommEphemeralWallet {
  const ecc = new Ecc()
  let secret = randomTmCommBytes(32)
  while (!ecc.isValidSeckey(secret)) {
    secret = randomTmCommBytes(32)
  }
  const publicKey = ecc.derivePubkey(secret)
  const address = Address.p2pkh(shaRmd160(publicKey)).address
  const publicKeyHex = toHex(publicKey)
  return Object.freeze({
    publicKeyHex,
    address,
    sign(message: string) {
      return signMsg(message, secret)
    }
  })
}

export function cookieValue(setCookieHeaders: readonly string[], cookieName: string): string | null {
  for (const header of setCookieHeaders) {
    const match = new RegExp(`^${cookieName}=([^;]+)`).exec(header)
    if (match) return match[1]
  }
  return null
}
