import type { ScriptUtxo } from 'chronik-client'
import { describe, expect, test, vi } from 'vitest'
import {
  ECASH_STANDARD_PROFILE_ID,
  TONALLI_LEGACY_PROFILE_ID,
  derivePublicMetadata
} from './derivationProfiles'
import {
  discoverDerivationProfile,
  scanDerivationProfile,
  summarizeTokenUtxos
} from './dualDerivationDiscovery'

const PUBLIC_TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

const utxo = (marker: string, sats = 1_000n, token?: ScriptUtxo['token']): ScriptUtxo => ({
  outpoint: { txid: marker.repeat(64), outIdx: 0 },
  blockHeight: 1,
  isCoinbase: false,
  isFinal: true,
  sats,
  token
} as ScriptUtxo)

const emptySnapshot = Object.freeze({ utxos: Object.freeze([]), hasHistory: false })

function discoveryReader(entries: Readonly<Record<string, {
  utxos?: readonly ScriptUtxo[]
  hasHistory?: boolean
}>>) {
  return vi.fn(async (address: string) => {
    const entry = entries[address]
    return entry
      ? Object.freeze({
          utxos: Object.freeze([...(entry.utxos ?? [])]),
          hasHistory: entry.hasHistory ?? false
        })
      : emptySnapshot
  })
}

describe('dual derivation discovery', () => {
  const legacyAddress = derivePublicMetadata(
    PUBLIC_TEST_MNEMONIC,
    TONALLI_LEGACY_PROFILE_ID,
    'receive',
    0
  ).address
  const standardAddress = derivePublicMetadata(
    PUBLIC_TEST_MNEMONIC,
    ECASH_STANDARD_PROFILE_ID,
    'receive',
    0
  ).address

  test('selects legacy when only 899 has activity', async () => {
    const result = await discoverDerivationProfile(PUBLIC_TEST_MNEMONIC, 2, {
      readAddress: discoveryReader({ [legacyAddress]: { hasHistory: true } })
    })
    expect(result).toMatchObject({
      kind: 'selected',
      reason: 'only-legacy',
      selectedProfileId: TONALLI_LEGACY_PROFILE_ID
    })
  })

  test('selects standard when only 1899 has UTXOs and discovers generic tokens', async () => {
    const token = {
      tokenId: 'ab'.repeat(32),
      tokenType: { protocol: 'ALP', type: 'ALP_TOKEN_TYPE_STANDARD', number: 0 },
      atoms: 42n,
      isMintBaton: false
    } as NonNullable<ScriptUtxo['token']>
    const result = await discoverDerivationProfile(PUBLIC_TEST_MNEMONIC, 2, {
      readAddress: discoveryReader({
        [standardAddress]: { utxos: [utxo('a', 546n, token)] }
      })
    })

    expect(result).toMatchObject({
      kind: 'selected',
      reason: 'only-standard',
      selectedProfileId: ECASH_STANDARD_PROFILE_ID
    })
    expect(result.profiles[ECASH_STANDARD_PROFILE_ID]).toMatchObject({
      xecSats: 546n,
      tokenUtxoCount: 1,
      activeAddressCount: 1,
      scannedAddressCount: 6,
      tokens: [{ tokenId: token.tokenId, protocol: 'ALP', tokenType: 0, atoms: 42n, utxoCount: 1 }]
    })
  })

  test('defaults an empty seed to standard 1899', async () => {
    const result = await discoverDerivationProfile(PUBLIC_TEST_MNEMONIC, 1, {
      readAddress: discoveryReader({})
    })
    expect(result).toMatchObject({
      kind: 'selected',
      reason: 'empty',
      selectedProfileId: ECASH_STANDARD_PROFILE_ID
    })
  })

  test('requires an explicit choice when both profiles have activity', async () => {
    const result = await discoverDerivationProfile(PUBLIC_TEST_MNEMONIC, 1, {
      readAddress: discoveryReader({
        [legacyAddress]: { hasHistory: true },
        [standardAddress]: { utxos: [utxo('b')] }
      })
    })
    expect(result.kind).toBe('choice-required')
    expect(result.reason).toBe('dual-activity')
    expect(result.selectedProfileId).toBeUndefined()
  })

  test('derives public metadata and scans both branches without signing hooks', async () => {
    const derivePublic = vi.fn(derivePublicMetadata)
    const readAddress = discoveryReader({})
    const result = await scanDerivationProfile(
      PUBLIC_TEST_MNEMONIC,
      ECASH_STANDARD_PROFILE_ID,
      3,
      { derivePublic, readAddress }
    )

    expect(result.scannedAddressCount).toBe(6)
    expect(derivePublic).toHaveBeenCalledTimes(6)
    expect(derivePublic.mock.calls.map(call => call[2])).toEqual([
      'receive', 'change', 'receive', 'change', 'receive', 'change'
    ])
    expect(readAddress).toHaveBeenCalledTimes(6)
  })

  test('resets the full gap after late activity like the existing HD scanner', async () => {
    const lateAddress = derivePublicMetadata(
      PUBLIC_TEST_MNEMONIC,
      TONALLI_LEGACY_PROFILE_ID,
      'change',
      2
    ).address
    const result = await scanDerivationProfile(
      PUBLIC_TEST_MNEMONIC,
      TONALLI_LEGACY_PROFILE_ID,
      3,
      { readAddress: discoveryReader({ [lateAddress]: { hasHistory: true } }) }
    )

    expect(result.activeAddressCount).toBe(1)
    expect(result.scannedAddressCount).toBe(12)
  })

  test('aggregates token UTXOs by canonical token identity', () => {
    const token = {
      tokenId: 'cd'.repeat(32),
      tokenType: { protocol: 'SLP', type: 'SLP_TOKEN_TYPE_FUNGIBLE', number: 1 },
      atoms: 5n,
      isMintBaton: false
    } as NonNullable<ScriptUtxo['token']>
    expect(summarizeTokenUtxos([
      utxo('c', 546n, token),
      utxo('d', 546n, { ...token, atoms: 7n })
    ])).toEqual([{
      tokenId: token.tokenId,
      protocol: 'SLP',
      tokenType: 1,
      atoms: 12n,
      utxoCount: 2
    }])
  })
})
