import CryptoJS from 'crypto-js'
import { Address, Ecc, fromHex, mnemonicToSeed, shaRmd160, toHex } from 'ecash-lib'

export const TONALLI_LEGACY_899_BASE_PATH = "m/44'/899'/0'" as const

export type Legacy899Branch = 'receive' | 'change'

export type Legacy899AccountPublicState = Readonly<{
  publicKeyHex: string
  chainCodeHex: string
  depth: number
  index: number
  parentFingerprint: number
}>

export type Legacy899DerivedPublicKey = Readonly<{
  address: string
  publicKeyHex: string
  hash160Hex: string
}>

export type Legacy899DerivedSigningKey = Legacy899DerivedPublicKey & Readonly<{
  privateKey: Uint8Array
}>

type LegacyPrivateNode = {
  privateKey: Uint8Array
  chainCode: Uint8Array
  depth: number
  index: number
  parentFingerprint: number
}

const ecc = new Ecc()
const textEncoder = new TextEncoder()

const assertIndex = (index: number) => {
  if (!Number.isSafeInteger(index) || index < 0 || index > 0x7fffffff) {
    throw new Error('El índice HD legacy debe ser un entero entre 0 y 2^31 - 1.')
  }
}

const concatBytes = (...chunks: readonly Uint8Array[]) => {
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

const uint32Be = (value: number) => new Uint8Array([
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff
])

const bytesToWordArray = (bytes: Uint8Array) => CryptoJS.enc.Hex.parse(toHex(bytes))

const hmacSha512 = (key: Uint8Array, data: Uint8Array): Uint8Array => fromHex(
  CryptoJS.HmacSHA512(bytesToWordArray(data), bytesToWordArray(key))
    .toString(CryptoJS.enc.Hex)
)

const fingerprint = (publicKey: Uint8Array) => {
  const bytes = shaRmd160(publicKey).slice(0, 4)
  return ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0
}

const masterFromSeed = (seed: Uint8Array): LegacyPrivateNode => {
  const digest = hmacSha512(textEncoder.encode('Bitcoin seed'), seed)
  try {
    return {
      privateKey: digest.slice(0, 32),
      chainCode: digest.slice(32, 64),
      depth: 0,
      index: 0,
      parentFingerprint: 0
    }
  } finally {
    digest.fill(0)
  }
}

/**
 * Reproduce minimal-xec-wallet@2.0.2 exactly. Its child-key algorithm uses
 * HMAC-SHA512's IL directly as the next private key instead of BIP32's
 * (IL + parentKey) mod n. This is intentionally compatibility code, not BIP32.
 */
const deriveChild = (
  parent: LegacyPrivateNode,
  index: number,
  hardened: boolean
): LegacyPrivateNode => {
  assertIndex(index)
  const parentPublicKey = ecc.derivePubkey(parent.privateKey)
  const encodedIndex = uint32Be(hardened ? index + 0x80000000 : index)
  const data = hardened
    ? concatBytes(new Uint8Array([0]), parent.privateKey, encodedIndex)
    : concatBytes(parentPublicKey, encodedIndex)
  const digest = hmacSha512(parent.chainCode, data)
  try {
    const privateKey = digest.slice(0, 32)
    // Match the historical failure behavior for the astronomically unlikely
    // invalid IL case before accepting this node.
    ecc.derivePubkey(privateKey)
    return {
      privateKey,
      chainCode: digest.slice(32, 64),
      depth: parent.depth + 1,
      index,
      parentFingerprint: fingerprint(parentPublicKey)
    }
  } finally {
    parentPublicKey.fill(0)
    encodedIndex.fill(0)
    data.fill(0)
    digest.fill(0)
  }
}

const derivePublicChild = (
  parentPublicKey: Uint8Array,
  parentChainCode: Uint8Array,
  index: number
): LegacyPrivateNode => {
  assertIndex(index)
  const encodedIndex = uint32Be(index)
  const data = concatBytes(parentPublicKey, encodedIndex)
  const digest = hmacSha512(parentChainCode, data)
  try {
    const privateKey = digest.slice(0, 32)
    ecc.derivePubkey(privateKey)
    return {
      privateKey,
      chainCode: digest.slice(32, 64),
      depth: 0,
      index,
      parentFingerprint: fingerprint(parentPublicKey)
    }
  } finally {
    encodedIndex.fill(0)
    data.fill(0)
    digest.fill(0)
  }
}

const wipeNode = (node: LegacyPrivateNode) => {
  node.privateKey.fill(0)
  node.chainCode.fill(0)
}

const derivePrivatePath = (
  mnemonic: string,
  segments: readonly Readonly<{ index: number; hardened: boolean }>[]
): LegacyPrivateNode => {
  const seed = mnemonicToSeed(mnemonic.trim(), '')
  let current = masterFromSeed(seed)
  try {
    for (const segment of segments) {
      const next = deriveChild(current, segment.index, segment.hardened)
      wipeNode(current)
      current = next
    }
    return current
  } catch (error) {
    wipeNode(current)
    throw error
  } finally {
    seed.fill(0)
  }
}

const publicMetadata = (privateKey: Uint8Array): Legacy899DerivedPublicKey => {
  const publicKey = ecc.derivePubkey(privateKey)
  const hash160 = shaRmd160(publicKey)
  return Object.freeze({
    address: Address.p2pkh(hash160).toString(),
    publicKeyHex: toHex(publicKey),
    hash160Hex: toHex(hash160)
  })
}

export function deriveLegacy899AccountPublicState(
  mnemonic: string
): Legacy899AccountPublicState {
  const account = derivePrivatePath(mnemonic, [
    { index: 44, hardened: true },
    { index: 899, hardened: true },
    { index: 0, hardened: true }
  ])
  try {
    return Object.freeze({
      publicKeyHex: toHex(ecc.derivePubkey(account.privateKey)),
      chainCodeHex: toHex(account.chainCode),
      depth: account.depth,
      index: account.index,
      parentFingerprint: account.parentFingerprint
    })
  } finally {
    wipeNode(account)
  }
}

/**
 * Derive address metadata from the historical account public tuple. The
 * historical algorithm necessarily materializes IL as temporary private bytes
 * even for discovery; those bytes are wiped before this function returns.
 */
export function deriveLegacy899PublicMetadata(
  account: Legacy899AccountPublicState,
  branch: Legacy899Branch,
  index: number
): Legacy899DerivedPublicKey {
  assertIndex(index)
  const accountPublicKey = fromHex(account.publicKeyHex)
  const accountChainCode = fromHex(account.chainCodeHex)
  const branchIndex = branch === 'receive' ? 0 : 1
  const branchNode = derivePublicChild(accountPublicKey, accountChainCode, branchIndex)
  try {
    const branchPublicKey = ecc.derivePubkey(branchNode.privateKey)
    const leafNode = derivePublicChild(branchPublicKey, branchNode.chainCode, index)
    branchPublicKey.fill(0)
    try {
      return publicMetadata(leafNode.privateKey)
    } finally {
      wipeNode(leafNode)
    }
  } finally {
    accountPublicKey.fill(0)
    accountChainCode.fill(0)
    wipeNode(branchNode)
  }
}

export function deriveLegacy899SigningKey(
  mnemonic: string,
  branch: Legacy899Branch,
  index: number
): Legacy899DerivedSigningKey {
  assertIndex(index)
  const branchIndex = branch === 'receive' ? 0 : 1
  const leaf = derivePrivatePath(mnemonic, [
    { index: 44, hardened: true },
    { index: 899, hardened: true },
    { index: 0, hardened: true },
    { index: branchIndex, hardened: false },
    { index, hardened: false }
  ])
  try {
    return Object.freeze({
      ...publicMetadata(leaf.privateKey),
      privateKey: leaf.privateKey.slice()
    })
  } finally {
    wipeNode(leaf)
  }
}
