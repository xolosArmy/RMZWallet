import { createRequire } from 'node:module'
import type { ScriptUtxo } from 'chronik-client'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  ECASH_STANDARD_PROFILE_ID,
  TONALLI_LEGACY_PROFILE_ID,
  deriveAccountPublicState,
  derivePublicMetadata
} from './derivationProfiles'
import type {
  AccountPublicState,
  DerivationProfileId,
  SigningDerivationMetadata
} from './derivationProfiles'
import { partitionWalletSats, xolosWalletService } from './XolosWalletService'
import type { FirmaInputOwner } from './firmaAlphaSend'

const require = createRequire(import.meta.url)
const MinimalXECWallet = require('minimal-xec-wallet') as new (
  mnemonic: string,
  options: { hdPath: string; chronikUrls: string[]; enableDonations: boolean }
) => { walletInfoPromise: Promise<{ xecAddress: string; publicKey: string }> }

const PUBLIC_TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const CASHTAB_1899_ADDRESS = 'ecash:qrwzys2q6xq98vwz0kjn6ulu5m6yljr5fyc909kalg'
const CASHTAB_1899_PUBLIC_KEY =
  '03ee1364cd7af3a9ffbbbd886388776a6f92a7b8dd986f6a8578885e4b856f7bfb'

type IdentityInternals = {
  wallet: unknown
  isReady: boolean
  decryptedMnemonic: string | null
  activeProfileId: DerivationProfileId
  activeAccountState: AccountPublicState | null
  hdAddressCache: FirmaInputOwner[]
  scanCache: unknown
  getFirmaChangeOwner: () => FirmaInputOwner
  fetchAddressScan: (address: string) => Promise<{
    address: string
    utxos: ScriptUtxo[]
    hasHistory: boolean
  }>
  scanAddressesForRescan: (
    gapLimit: number,
    startIndex: number,
    maxAddresses?: number
  ) => Promise<{
    owners: FirmaInputOwner[]
    balances: { xec: bigint }
  }>
  deriveSigningMetadataForOwner: (owner: FirmaInputOwner) => SigningDerivationMetadata
  bindMinimalWalletToCanonicalProfile: (mnemonic: string) => void
}

const internals = xolosWalletService as unknown as IdentityInternals
const originalState = {
  wallet: internals.wallet,
  isReady: internals.isReady,
  decryptedMnemonic: internals.decryptedMnemonic,
  activeProfileId: internals.activeProfileId,
  activeAccountState: internals.activeAccountState,
  hdAddressCache: internals.hdAddressCache,
  scanCache: internals.scanCache
}

function activatePublicFixture(profileId: DerivationProfileId) {
  internals.wallet = {
    // Deliberately incompatible: canonical getters must never read these fields.
    walletInfo: {
      xecAddress: 'ecash:qrrd3y2cmg6m2vxlng9h3djh889pmwffhqv9yym2p4',
      publicKey: `02${'11'.repeat(32)}`
    }
  }
  internals.isReady = true
  internals.decryptedMnemonic = PUBLIC_TEST_MNEMONIC
  internals.activeProfileId = profileId
  internals.activeAccountState = deriveAccountPublicState(PUBLIC_TEST_MNEMONIC, profileId)
  internals.hdAddressCache = []
  internals.scanCache = null
}

afterEach(() => {
  vi.restoreAllMocks()
  Object.assign(internals, originalState)
})

describe('canonical active identity boundary', () => {
  test('publishes Cashtab receive/0 through every active account getter', () => {
    activatePublicFixture(ECASH_STANDARD_PROFILE_ID)

    expect(xolosWalletService.getAddress()).toBe(CASHTAB_1899_ADDRESS)
    expect(xolosWalletService.getPublicKeyHex()).toBe(CASHTAB_1899_PUBLIC_KEY)
    expect(xolosWalletService.getKeyInfo()).toMatchObject({
      xecAddress: CASHTAB_1899_ADDRESS,
      address: CASHTAB_1899_ADDRESS,
      publicKeyHex: CASHTAB_1899_PUBLIC_KEY
    })
    expect(xolosWalletService.getX402ActiveAccount()).toEqual({
      address: CASHTAB_1899_ADDRESS,
      publicKey: CASHTAB_1899_PUBLIC_KEY
    })
    expect(xolosWalletService.getSignatory()).toMatchObject({
      address: CASHTAB_1899_ADDRESS,
      publicKeyHex: CASHTAB_1899_PUBLIC_KEY
    })
  })

  test('uses canonical receive/0 directly as FIRMA change without Minimal wallet identity', () => {
    activatePublicFixture(ECASH_STANDARD_PROFILE_ID)

    expect(internals.getFirmaChangeOwner()).toEqual({
      profileId: ECASH_STANDARD_PROFILE_ID,
      account: 0,
      branch: 'receive',
      index: 0,
      hdPath: "m/44'/1899'/0'/0/0",
      address: CASHTAB_1899_ADDRESS,
      publicKeyHex: CASHTAB_1899_PUBLIC_KEY
    })
  })

  test('preserves the legacy 899 receive/0 identity', () => {
    activatePublicFixture(TONALLI_LEGACY_PROFILE_ID)
    const expected = derivePublicMetadata(
      deriveAccountPublicState(PUBLIC_TEST_MNEMONIC, TONALLI_LEGACY_PROFILE_ID),
      'receive',
      0
    )

    expect(xolosWalletService.getAddress()).toBe(expected.address)
    expect(xolosWalletService.getAddress()).toBe(
      'ecash:qr03uhyuv0cen3atackpru04watjlllxtu6aqnedrp'
    )
    expect(xolosWalletService.getPublicKeyHex()).toBe(expected.publicKeyHex)
    expect(xolosWalletService.getKeyInfo()).toMatchObject({
      address: expected.address,
      xecAddress: expected.address,
      publicKeyHex: expected.publicKeyHex
    })
    expect(xolosWalletService.getX402ActiveAccount()).toEqual({
      address: expected.address,
      publicKey: expected.publicKeyHex
    })
    expect(xolosWalletService.getSignatory()).toMatchObject({
      address: expected.address,
      publicKeyHex: expected.publicKeyHex
    })
    expect(internals.getFirmaChangeOwner().hdPath).toBe("m/44'/899'/0'/0/0")
  })

  test('rescans a historical balance and derives the matching historical signing key', async () => {
    activatePublicFixture(TONALLI_LEGACY_PROFILE_ID)
    const owner = derivePublicMetadata(
      deriveAccountPublicState(PUBLIC_TEST_MNEMONIC, TONALLI_LEGACY_PROFILE_ID),
      'receive',
      0
    )
    const historicalUtxo = {
      outpoint: { txid: 'ab'.repeat(32), outIdx: 0 },
      blockHeight: 1,
      isCoinbase: false,
      isFinal: true,
      sats: 12_345n
    } as ScriptUtxo

    vi.spyOn(internals, 'fetchAddressScan').mockImplementation(async address => ({
      address,
      utxos: address === owner.address ? [historicalUtxo] : [],
      hasHistory: address === owner.address
    }))
    vi.spyOn(xolosWalletService, 'getRmzDecimals').mockResolvedValue(0)
    vi.spyOn(xolosWalletService, 'getFirmaAlphaDecimals').mockResolvedValue(4)

    const scan = await internals.scanAddressesForRescan(1, 0, 1)
    const recoveredOwner = scan.owners.find(candidate => candidate.address === owner.address)

    expect(xolosWalletService.getAddress()).toBe(owner.address)
    expect(scan.balances.xec).toBe(12_345n)
    expect(recoveredOwner).toMatchObject({
      profileId: TONALLI_LEGACY_PROFILE_ID,
      hdPath: "m/44'/899'/0'/0/0",
      address: owner.address,
      publicKeyHex: owner.publicKeyHex
    })

    const signing = internals.deriveSigningMetadataForOwner(recoveredOwner!)
    expect(signing.address).toBe(owner.address)
    expect(signing.publicKeyHex).toBe(owner.publicKeyHex)
    expect(Buffer.from(signing.privateKey).toString('hex')).toBe(
      '08b84bb9461e833b2c0863b394eba483ca444abf17e909f41001f04107735b0a'
    )
  })

  test('records the MinimalXECWallet 2.0.2 derivation incompatibility without trusting it', async () => {
    const previousNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      const minimal = new MinimalXECWallet(PUBLIC_TEST_MNEMONIC, {
        hdPath: "m/44'/1899'/0'/0/0",
        chronikUrls: ['https://chronik.e.cash'],
        enableDonations: false
      })
      const walletInfo = await minimal.walletInfoPromise

      expect(walletInfo.xecAddress).toBe('ecash:qrrd3y2cmg6m2vxlng9h3djh889pmwffhqv9yym2p4')
      expect(walletInfo.xecAddress).not.toBe(CASHTAB_1899_ADDRESS)
      expect(walletInfo.publicKey).not.toBe(CASHTAB_1899_PUBLIC_KEY)

      activatePublicFixture(ECASH_STANDARD_PROFILE_ID)
      expect(xolosWalletService.getAddress()).toBe(CASHTAB_1899_ADDRESS)
    } finally {
      process.env.NODE_ENV = previousNodeEnv
    }
  })

  test('rebinds every Minimal wallet derivation port before utility initialization', () => {
    type DerivationPort = {
      deriveFromMnemonic: (mnemonic: string, hdPath?: string) => {
        address: string
        publicKey: string
        privateKey: string
      }
    }
    const staleDerive: DerivationPort['deriveFromMnemonic'] = () => ({
      address: 'ecash:qstale',
      publicKey: `02${'11'.repeat(32)}`,
      privateKey: '11'.repeat(32)
    })
    const port = (): DerivationPort => ({ deriveFromMnemonic: staleDerive })
    const walletInfo = {
      mnemonic: 'public-utility-fixture',
      xecAddress: 'ecash:qstale',
      publicKey: `02${'11'.repeat(32)}`,
      privateKey: '11'.repeat(32),
      hdPath: "m/44'/1899'/0'/0/0"
    }
    const wallet = {
      walletInfo,
      keyDerivation: port(),
      sendXecLib: { keyDerivation: port() },
      opReturn: { keyDerivation: port() },
      hybridTokens: {
        slpHandler: { keyDerivation: port() },
        alpHandler: { keyDerivation: port() }
      }
    }

    activatePublicFixture(ECASH_STANDARD_PROFILE_ID)
    internals.wallet = wallet
    internals.bindMinimalWalletToCanonicalProfile(PUBLIC_TEST_MNEMONIC)

    expect(walletInfo).toMatchObject({
      mnemonic: PUBLIC_TEST_MNEMONIC,
      xecAddress: CASHTAB_1899_ADDRESS,
      publicKey: CASHTAB_1899_PUBLIC_KEY,
      privateKey: undefined,
      hdPath: "m/44'/1899'/0'/0/0"
    })
    const ports = [
      wallet.keyDerivation,
      wallet.sendXecLib.keyDerivation,
      wallet.opReturn.keyDerivation,
      wallet.hybridTokens.slpHandler.keyDerivation,
      wallet.hybridTokens.alpHandler.keyDerivation
    ]
    for (const derivationPort of ports) {
      expect(derivationPort.deriveFromMnemonic(
        PUBLIC_TEST_MNEMONIC,
        "m/44'/1899'/0'/0/7"
      )).toMatchObject({
        address: derivePublicMetadata(
          deriveAccountPublicState(PUBLIC_TEST_MNEMONIC, ECASH_STANDARD_PROFILE_ID),
          'receive',
          7
        ).address
      })
    }
    expect(() => ports[0].deriveFromMnemonic(
      PUBLIC_TEST_MNEMONIC,
      "m/44'/899'/0'/0/0"
    )).toThrow(/perfil activo/)
  })
})

describe('wallet XEC balance partition', () => {
  const utxo = (marker: string, sats: bigint, token?: ScriptUtxo['token']) => ({
    outpoint: { txid: marker.repeat(64), outIdx: 0 },
    blockHeight: 1,
    isCoinbase: false,
    isFinal: true,
    sats,
    token
  }) as ScriptUtxo

  test('counts only pure XEC as spendable fee balance', () => {
    const token = {
      tokenId: 'ab'.repeat(32),
      tokenType: { protocol: 'ALP', type: 'ALP_TOKEN_TYPE_STANDARD', number: 0 },
      atoms: 152_142n,
      isMintBaton: false
    } as NonNullable<ScriptUtxo['token']>

    expect(partitionWalletSats([
      utxo('a', 546n, token),
      utxo('b', 2_000n)
    ])).toEqual({ spendableXecSats: 2_000n, tokenUtxoSats: 546n })
    expect(partitionWalletSats([utxo('c', 546n, token)]))
      .toEqual({ spendableXecSats: 0n, tokenUtxoSats: 546n })
  })
})
