const prefixes = Object.freeze({
  principal: 'prin',
  binding: 'bind',
  conversation: 'conv',
  message: 'msg',
  receipt: 'rcpt',
  audit: 'aud',
  enrollment: 'enrl',
  challenge: 'chlg',
  session: 'sess',
  reservation: 'rsv',
  token: 'tok'
} as const)

export type TmCommIdKind = keyof typeof prefixes

export function createTmCommId(kind: TmCommIdKind): string {
  return `${prefixes[kind]}_${createTmCommSecretHex(16)}`
}

export function randomTmCommBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  globalThis.crypto.getRandomValues(bytes)
  return bytes
}

export function createTmCommSecretHex(bytes = 32): string {
  return Buffer.from(randomTmCommBytes(bytes)).toString('hex')
}
