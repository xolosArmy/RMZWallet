import { Address, HdNode, mnemonicToSeed, shaRmd160, toHex } from 'ecash-lib'
import { describe, expect, test } from 'vitest'
import {
  DEFAULT_NEW_WALLET_PROFILE_ID,
  ECASH_STANDARD_PROFILE_ID,
  TONALLI_LEGACY_PROFILE_ID,
  accountXpubToWatchOnlyNode,
  deriveAccountXpub,
  deriveSigningMetadata,
  deriveWatchOnlyMetadata,
  getDerivationPath,
  parseStoredDerivationProfileMetadata,
  serializeStoredDerivationProfileMetadata
} from './derivationProfiles'

// Public BIP39 vector. It is deliberately burned and must never hold funds.
const PUBLIC_TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('Tonalli dual BIP44 derivation profiles', () => {
  test('derives deterministic and distinct receive-0 identities for 899 and 1899', () => {
    const legacyXpub = deriveAccountXpub(PUBLIC_TEST_MNEMONIC, TONALLI_LEGACY_PROFILE_ID)
    const standardXpub = deriveAccountXpub(PUBLIC_TEST_MNEMONIC, ECASH_STANDARD_PROFILE_ID)
    const legacy = deriveWatchOnlyMetadata(legacyXpub, 'receive', 0)
    const standard = deriveWatchOnlyMetadata(standardXpub, 'receive', 0)

    expect(legacy.hdPath).toBe("m/44'/899'/0'/0/0")
    expect(legacy.address).toBe('ecash:qpluxjhhlxfjwsymf9nmctvsdrwzwygadsh2pq0ang')
    expect(legacy.publicKeyHex).toBe(
      '03602543a67787c0778df0153e879b33eb16e3759ae63dbed6e9bd3704bfe7a236'
    )
    expect(standard.hdPath).toBe("m/44'/1899'/0'/0/0")
    expect(standard.address).toBe('ecash:qrwzys2q6xq98vwz0kjn6ulu5m6yljr5fyc909kalg')
    expect(standard.publicKeyHex).toBe(
      '03ee1364cd7af3a9ffbbbd886388776a6f92a7b8dd986f6a8578885e4b856f7bfb'
    )
    expect(standard.hash160Hex).toBe('dc224140d18053b1c27da53d73fca6f44fc87449')
    expect(legacy.address).not.toBe(standard.address)
    expect(deriveWatchOnlyMetadata(standardXpub, 'receive', 0)).toEqual(standard)
  })

  test('matches the current Cashtab 1899 fixture including its test-only secret derivation', () => {
    const node = HdNode.fromSeed(mnemonicToSeed(PUBLIC_TEST_MNEMONIC, ''))
      .derivePath("m/44'/1899'/0'/0/0")
    const standard = deriveWatchOnlyMetadata(
      deriveAccountXpub(PUBLIC_TEST_MNEMONIC, ECASH_STANDARD_PROFILE_ID),
      'receive',
      0
    )

    expect(toHex(node.pubkey())).toBe(standard.publicKeyHex)
    expect(toHex(node.seckey()!)).toBe(
      '97f2d7fa9745baa45fc1b53be3ecead6c000265cc5115aa4ae4d1f452057eb0c'
    )
    expect(standard.address).toBe('ecash:qrwzys2q6xq98vwz0kjn6ulu5m6yljr5fyc909kalg')
  })

  test('re-enters private derivation only for the exact requested signing path', () => {
    const watchOnly = deriveWatchOnlyMetadata(
      deriveAccountXpub(PUBLIC_TEST_MNEMONIC, ECASH_STANDARD_PROFILE_ID),
      'receive',
      7
    )
    const signing = deriveSigningMetadata(
      PUBLIC_TEST_MNEMONIC,
      ECASH_STANDARD_PROFILE_ID,
      'receive',
      7
    )

    expect(signing.hdPath).toBe("m/44'/1899'/0'/0/7")
    expect(signing.address).toBe(watchOnly.address)
    expect(signing.publicKeyHex).toBe(watchOnly.publicKeyHex)
    expect(signing.privateKey).toHaveLength(32)
    expect(signing.address).not.toBe(
      deriveWatchOnlyMetadata(
        deriveAccountXpub(PUBLIC_TEST_MNEMONIC, ECASH_STANDARD_PROFILE_ID),
        'receive',
        0
      ).address
    )
  })

  test('derives receive and change within the selected profile', () => {
    expect(getDerivationPath(TONALLI_LEGACY_PROFILE_ID, 'change', 7))
      .toBe("m/44'/899'/0'/1/7")
    expect(getDerivationPath(ECASH_STANDARD_PROFILE_ID, 'change', 0))
      .toBe("m/44'/1899'/0'/1/0")

    const cashtabChangeNode = HdNode.fromSeed(mnemonicToSeed(PUBLIC_TEST_MNEMONIC, ''))
      .derivePath("m/44'/1899'/0'/1/0")
    const tonalliChange = deriveWatchOnlyMetadata(
      deriveAccountXpub(PUBLIC_TEST_MNEMONIC, ECASH_STANDARD_PROFILE_ID),
      'change',
      0
    )
    expect(tonalliChange.publicKeyHex).toBe(toHex(cashtabChangeNode.pubkey()))
    expect(tonalliChange.address).toBe(
      Address.p2pkh(shaRmd160(cashtabChangeNode.pubkey())).toString()
    )

    const legacyXpub = deriveAccountXpub(PUBLIC_TEST_MNEMONIC, TONALLI_LEGACY_PROFILE_ID)
    for (const branch of ['receive', 'change'] as const) {
      const branchIndex = branch === 'receive' ? 0 : 1
      const previousFullPathNode = HdNode.fromSeed(mnemonicToSeed(PUBLIC_TEST_MNEMONIC, ''))
        .derivePath(`m/44'/899'/0'/${branchIndex}/4`)
      const watchOnly = deriveWatchOnlyMetadata(legacyXpub, branch, 4)
      expect(watchOnly.publicKeyHex).toBe(toHex(previousFullPathNode.pubkey()))
      expect(watchOnly.address).toBe(
        Address.p2pkh(shaRmd160(previousFullPathNode.pubkey())).toString()
      )
    }
  })

  test('reconstructs account and child nodes as strictly watch-only', () => {
    const accountXpub = deriveAccountXpub(PUBLIC_TEST_MNEMONIC, ECASH_STANDARD_PROFILE_ID)
    const accountNode = accountXpubToWatchOnlyNode(accountXpub)

    expect(accountNode.seckey()).toBeUndefined()
    expect(accountNode.derive(0).derive(7).seckey()).toBeUndefined()
    expect(deriveWatchOnlyMetadata(accountXpub, 'receive', 7).hdPath)
      .toBe("m/44'/1899'/0'/0/7")
  })

  test('serializes an explicitly recovered legacy profile deterministically', () => {
    const legacyXpub = deriveAccountXpub(PUBLIC_TEST_MNEMONIC, TONALLI_LEGACY_PROFILE_ID)
    const addressBeforeMigration = deriveWatchOnlyMetadata(legacyXpub, 'receive', 0).address
    expect(deriveWatchOnlyMetadata(legacyXpub, 'receive', 0).address).toBe(addressBeforeMigration)
    expect(addressBeforeMigration).toBe('ecash:qpluxjhhlxfjwsymf9nmctvsdrwzwygadsh2pq0ang')

    const serialized = serializeStoredDerivationProfileMetadata(TONALLI_LEGACY_PROFILE_ID)
    expect(parseStoredDerivationProfileMetadata(serialized)).toEqual({
      version: 1,
      derivationProfile: TONALLI_LEGACY_PROFILE_ID
    })
  })

  test('defaults a new wallet without stored state to the interoperable profile', () => {
    expect(DEFAULT_NEW_WALLET_PROFILE_ID).toBe(ECASH_STANDARD_PROFILE_ID)
  })
})
