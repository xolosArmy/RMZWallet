import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  deriveLegacy899AccountPublicState,
  deriveLegacy899PublicMetadata,
  deriveLegacy899SigningKey
} from './legacy899Compatibility'

const require = createRequire(import.meta.url)
const minimalWalletEntry = require.resolve('minimal-xec-wallet')
const KeyDerivation = require(join(
  dirname(minimalWalletEntry),
  'lib/key-derivation.js'
)) as new () => {
  deriveFromMnemonic(mnemonic: string, hdPath: string): {
    address: string
    publicKey: string
    privateKey: string
  }
}

const PUBLIC_TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

const GOLDEN = Object.freeze([
  Object.freeze({
    branch: 'receive' as const,
    index: 0,
    hdPath: "m/44'/899'/0'/0/0",
    address: 'ecash:qr03uhyuv0cen3atackpru04watjlllxtu6aqnedrp',
    publicKeyHex: '024bf38c8532f655cc1de47083a4ab9dc35378897fce16b2c9de0df522812ed3c6',
    privateKeyHex: '08b84bb9461e833b2c0863b394eba483ca444abf17e909f41001f04107735b0a'
  }),
  Object.freeze({
    branch: 'receive' as const,
    index: 1,
    hdPath: "m/44'/899'/0'/0/1",
    address: 'ecash:qpzptscwesxqswjxweq9343lc4xgwk9xuuqkpamwrh',
    publicKeyHex: '03eec3600b52dd3744fd021a199b873ba0a000a5264c83d4efe0030e0a86098b9a',
    privateKeyHex: '7593f754497a54911180a189a7031e4e1b41b904a636e71dd36123a6c574e001'
  }),
  Object.freeze({
    branch: 'receive' as const,
    index: 19,
    hdPath: "m/44'/899'/0'/0/19",
    address: 'ecash:qpnku5pz7h29jkpga99py72gnrksaalzscrjnwnzvt',
    publicKeyHex: '028af80d493d60050bde2df928967f3b99cbfc9992ad699c624d3fb99ca7f979d9',
    privateKeyHex: 'fe9b762142b40c5a413a386c8a6e8754c61a4d22d2e8d1a61e57d6d048056354'
  }),
  Object.freeze({
    branch: 'change' as const,
    index: 0,
    hdPath: "m/44'/899'/0'/1/0",
    address: 'ecash:qra3f6utq7gfnmc8akunmgkwyas7z7au2cwfwftg6l',
    publicKeyHex: '028a2c6be8cffeffdd2804a4bc168befb162e0fb7e916de0377bdabee8ea35ec9e',
    privateKeyHex: '1a33a1ff62b3229fec08e5ebbc79f1c21f62a781bc8572acb4d528cab0853c28'
  }),
  Object.freeze({
    branch: 'change' as const,
    index: 1,
    hdPath: "m/44'/899'/0'/1/1",
    address: 'ecash:qzugx8yppd2w2wk635kw4kj6y70rv6pgluzdu7zf9c',
    publicKeyHex: '03aca8b9dcb630ac7b624d7e995835f1a8700d42d93e76f9af025bf2ffd02df30a',
    privateKeyHex: 'cfd0d5a70935dff96e2d6c70160e73f36889822df9ba63a03e429aff6b2f1a35'
  })
])

const previousNodeEnv = process.env.NODE_ENV

afterEach(() => {
  process.env.NODE_ENV = previousNodeEnv
})

describe('minimal-xec-wallet 2.0.2 legacy compatibility engine', () => {
  test.each(GOLDEN)('matches frozen $hdPath golden fixture', fixture => {
    const account = deriveLegacy899AccountPublicState(PUBLIC_TEST_MNEMONIC)
    const publicMetadata = deriveLegacy899PublicMetadata(
      account,
      fixture.branch,
      fixture.index
    )
    const signing = deriveLegacy899SigningKey(
      PUBLIC_TEST_MNEMONIC,
      fixture.branch,
      fixture.index
    )

    expect(publicMetadata).toMatchObject({
      address: fixture.address,
      publicKeyHex: fixture.publicKeyHex
    })
    expect(signing).toMatchObject({
      address: fixture.address,
      publicKeyHex: fixture.publicKeyHex
    })
    expect(Buffer.from(signing.privateKey).toString('hex')).toBe(fixture.privateKeyHex)
  })

  test('matches the historical dependency oracle byte-for-byte outside its test mock mode', () => {
    process.env.NODE_ENV = 'production'
    const oracle = new KeyDerivation()
    for (const fixture of GOLDEN) {
      expect(oracle.deriveFromMnemonic(PUBLIC_TEST_MNEMONIC, fixture.hdPath)).toEqual({
        address: fixture.address,
        publicKey: fixture.publicKeyHex,
        privateKey: fixture.privateKeyHex
      })
    }
  })
})
