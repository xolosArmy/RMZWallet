import { Address, HdNode, mnemonicToSeed, shaRmd160, toHex } from 'ecash-lib'
import { describe, expect, test } from 'vitest'
import {
  DEFAULT_NEW_WALLET_PROFILE_ID,
  ECASH_LIB_DERIVATION_ENGINE,
  ECASH_STANDARD_899_PROFILE_ID,
  ECASH_STANDARD_PROFILE_ID,
  TONALLI_LEGACY_DERIVATION_ENGINE,
  TONALLI_LEGACY_PROFILE_ID,
  accountPublicStateToWatchOnlyNode,
  deriveAccountPublicState,
  derivePublicMetadata,
  deriveSigningMetadata,
  getDerivationPath,
  parseStoredDerivationProfileMetadata,
  serializeStoredDerivationProfileMetadata
} from './derivationProfiles'

// Public BIP39 vector. It is deliberately burned and must never hold funds.
const PUBLIC_TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

const HISTORICAL_899_ADDRESS = 'ecash:qr03uhyuv0cen3atackpru04watjlllxtu6aqnedrp'
const HISTORICAL_899_PUBLIC_KEY =
  '024bf38c8532f655cc1de47083a4ab9dc35378897fce16b2c9de0df522812ed3c6'
const STANDARD_899_ADDRESS = 'ecash:qpluxjhhlxfjwsymf9nmctvsdrwzwygadsh2pq0ang'
const CASHTAB_1899_ADDRESS = 'ecash:qrwzys2q6xq98vwz0kjn6ulu5m6yljr5fyc909kalg'

describe('Tonalli derivation profiles and engines', () => {
  test('keeps historical 899, standard 899 and Cashtab 1899 cryptographically distinct', () => {
    const historical = derivePublicMetadata(
      deriveAccountPublicState(PUBLIC_TEST_MNEMONIC, TONALLI_LEGACY_PROFILE_ID),
      'receive',
      0
    )
    const standard899 = derivePublicMetadata(
      deriveAccountPublicState(PUBLIC_TEST_MNEMONIC, ECASH_STANDARD_899_PROFILE_ID),
      'receive',
      0
    )
    const standard1899 = derivePublicMetadata(
      deriveAccountPublicState(PUBLIC_TEST_MNEMONIC, ECASH_STANDARD_PROFILE_ID),
      'receive',
      0
    )

    expect(historical).toMatchObject({
      engine: TONALLI_LEGACY_DERIVATION_ENGINE,
      hdPath: "m/44'/899'/0'/0/0",
      address: HISTORICAL_899_ADDRESS,
      publicKeyHex: HISTORICAL_899_PUBLIC_KEY
    })
    expect(standard899).toMatchObject({
      engine: ECASH_LIB_DERIVATION_ENGINE,
      hdPath: "m/44'/899'/0'/0/0",
      address: STANDARD_899_ADDRESS,
      publicKeyHex: '03602543a67787c0778df0153e879b33eb16e3759ae63dbed6e9bd3704bfe7a236'
    })
    expect(standard1899).toMatchObject({
      engine: ECASH_LIB_DERIVATION_ENGINE,
      hdPath: "m/44'/1899'/0'/0/0",
      address: CASHTAB_1899_ADDRESS,
      publicKeyHex: '03ee1364cd7af3a9ffbbbd886388776a6f92a7b8dd986f6a8578885e4b856f7bfb',
      hash160Hex: 'dc224140d18053b1c27da53d73fca6f44fc87449'
    })
    expect(historical.address).not.toBe(standard899.address)
    expect(new Set([historical.address, standard899.address, standard1899.address]).size).toBe(3)
  })

  test('matches the public Cashtab 1899 fixture including test-only secret derivation', () => {
    const node = HdNode.fromSeed(mnemonicToSeed(PUBLIC_TEST_MNEMONIC, ''))
      .derivePath("m/44'/1899'/0'/0/0")
    const standard = derivePublicMetadata(
      deriveAccountPublicState(PUBLIC_TEST_MNEMONIC, ECASH_STANDARD_PROFILE_ID),
      'receive',
      0
    )

    expect(toHex(node.pubkey())).toBe(standard.publicKeyHex)
    expect(toHex(node.seckey()!)).toBe(
      '97f2d7fa9745baa45fc1b53be3ecead6c000265cc5115aa4ae4d1f452057eb0c'
    )
    expect(standard.address).toBe(CASHTAB_1899_ADDRESS)
  })

  test('derives each signing key with the engine and exact path that produced its owner', () => {
    for (const profileId of [
      TONALLI_LEGACY_PROFILE_ID,
      ECASH_STANDARD_899_PROFILE_ID,
      ECASH_STANDARD_PROFILE_ID
    ] as const) {
      const owner = derivePublicMetadata(
        deriveAccountPublicState(PUBLIC_TEST_MNEMONIC, profileId),
        'receive',
        7
      )
      const signing = deriveSigningMetadata(PUBLIC_TEST_MNEMONIC, profileId, 'receive', 7)

      expect(signing.hdPath).toBe(owner.hdPath)
      expect(signing.engine).toBe(owner.engine)
      expect(signing.address).toBe(owner.address)
      expect(signing.publicKeyHex).toBe(owner.publicKeyHex)
      expect(signing.privateKey).toHaveLength(32)
    }
  })

  test('derives standard receive/change from strictly watch-only account tuples', () => {
    for (const profileId of [ECASH_STANDARD_899_PROFILE_ID, ECASH_STANDARD_PROFILE_ID] as const) {
      const account = deriveAccountPublicState(PUBLIC_TEST_MNEMONIC, profileId)
      const watchOnly = accountPublicStateToWatchOnlyNode(account)
      expect(watchOnly.seckey()).toBeUndefined()
      expect(watchOnly.derive(0).derive(7).seckey()).toBeUndefined()
    }

    expect(() => accountPublicStateToWatchOnlyNode(
      deriveAccountPublicState(PUBLIC_TEST_MNEMONIC, TONALLI_LEGACY_PROFILE_ID)
    )).toThrow(/no es un xpub BIP32/)
  })

  test('rejects an account tuple whose declared profile and engine do not match', () => {
    const standard899 = deriveAccountPublicState(
      PUBLIC_TEST_MNEMONIC,
      ECASH_STANDARD_899_PROFILE_ID
    )
    expect(() => derivePublicMetadata({
      ...standard899,
      profileId: TONALLI_LEGACY_PROFILE_ID
    }, 'receive', 0)).toThrow(/perfil y engine declarados/)
  })

  test('keeps canonical Cashtab change derivation unchanged', () => {
    expect(getDerivationPath(TONALLI_LEGACY_PROFILE_ID, 'change', 7))
      .toBe("m/44'/899'/0'/1/7")
    expect(getDerivationPath(ECASH_STANDARD_PROFILE_ID, 'change', 0))
      .toBe("m/44'/1899'/0'/1/0")

    const cashtabChangeNode = HdNode.fromSeed(mnemonicToSeed(PUBLIC_TEST_MNEMONIC, ''))
      .derivePath("m/44'/1899'/0'/1/0")
    const tonalliChange = derivePublicMetadata(
      deriveAccountPublicState(PUBLIC_TEST_MNEMONIC, ECASH_STANDARD_PROFILE_ID),
      'change',
      0
    )
    expect(tonalliChange.publicKeyHex).toBe(toHex(cashtabChangeNode.pubkey()))
    expect(tonalliChange.address).toBe(
      Address.p2pkh(shaRmd160(cashtabChangeNode.pubkey())).toString()
    )
  })

  test('persists engine-versioned metadata and rejects ambiguous version 1 metadata', () => {
    const serialized = serializeStoredDerivationProfileMetadata(TONALLI_LEGACY_PROFILE_ID)
    expect(parseStoredDerivationProfileMetadata(serialized)).toEqual({
      version: 2,
      derivationProfile: TONALLI_LEGACY_PROFILE_ID,
      engine: TONALLI_LEGACY_DERIVATION_ENGINE
    })
    expect(parseStoredDerivationProfileMetadata(
      '{"version":1,"derivationProfile":"tonalli-legacy-899"}'
    )).toBeNull()
    expect(parseStoredDerivationProfileMetadata(
      '{"version":2,"derivationProfile":"tonalli-legacy-899","engine":"ecash-lib-bip32"}'
    )).toBeNull()
  })

  test('defaults new wallets to interoperable 1899', () => {
    expect(DEFAULT_NEW_WALLET_PROFILE_ID).toBe(ECASH_STANDARD_PROFILE_ID)
  })
})
