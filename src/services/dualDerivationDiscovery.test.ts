import type { ScriptUtxo } from 'chronik-client'
import { describe, expect, test, vi } from 'vitest'
import {
  ECASH_STANDARD_899_PROFILE_ID,
  ECASH_STANDARD_PROFILE_ID,
  TONALLI_LEGACY_PROFILE_ID,
  deriveAccountPublicState,
  derivePublicMetadata,
  parseStoredDerivationProfileMetadata
} from './derivationProfiles'
import {
  discoverDerivationProfile,
  resolveProfileForMissingMetadata,
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

describe('three-engine derivation discovery', () => {
  const historicalAccount = deriveAccountPublicState(
    PUBLIC_TEST_MNEMONIC,
    TONALLI_LEGACY_PROFILE_ID
  )
  const standard899Account = deriveAccountPublicState(
    PUBLIC_TEST_MNEMONIC,
    ECASH_STANDARD_899_PROFILE_ID
  )
  const standard1899Account = deriveAccountPublicState(
    PUBLIC_TEST_MNEMONIC,
    ECASH_STANDARD_PROFILE_ID
  )
  const historicalAddress = derivePublicMetadata(historicalAccount, 'receive', 0).address
  const standard899Address = derivePublicMetadata(standard899Account, 'receive', 0).address
  const standard1899Address = derivePublicMetadata(standard1899Account, 'receive', 0).address

  test('recovers a historical Tonalli wallet from activity at the pre-PR-48 address', async () => {
    const historicalUtxo = utxo('a', 12_345n)
    const result = await discoverDerivationProfile(PUBLIC_TEST_MNEMONIC, 2, {
      readAddress: discoveryReader({
        [historicalAddress]: { hasHistory: true, utxos: [historicalUtxo] }
      })
    })

    expect(historicalAddress).toBe('ecash:qr03uhyuv0cen3atackpru04watjlllxtu6aqnedrp')
    expect(result).toMatchObject({
      kind: 'selected',
      reason: 'only-historical-899',
      selectedProfileId: TONALLI_LEGACY_PROFILE_ID
    })
    expect(result.profiles[TONALLI_LEGACY_PROFILE_ID]).toMatchObject({
      hasActivity: true,
      xecSats: 12_345n,
      activeAddressCount: 1
    })
    expect(resolveProfileForMissingMetadata(result)).toBe(TONALLI_LEGACY_PROFILE_ID)
  })

  test('recovers the standard-899 compatibility window independently', async () => {
    const result = await discoverDerivationProfile(PUBLIC_TEST_MNEMONIC, 1, {
      readAddress: discoveryReader({ [standard899Address]: { hasHistory: true } })
    })
    expect(result).toMatchObject({
      kind: 'selected',
      reason: 'only-standard-899',
      selectedProfileId: ECASH_STANDARD_899_PROFILE_ID
    })
  })

  test('keeps 1899/Cashtab discovery and generic token aggregation unchanged', async () => {
    const token = {
      tokenId: 'ab'.repeat(32),
      tokenType: { protocol: 'ALP', type: 'ALP_TOKEN_TYPE_STANDARD', number: 0 },
      atoms: 42n,
      isMintBaton: false
    } as NonNullable<ScriptUtxo['token']>
    const result = await discoverDerivationProfile(PUBLIC_TEST_MNEMONIC, 2, {
      readAddress: discoveryReader({
        [standard1899Address]: { utxos: [utxo('b', 546n, token)] }
      })
    })

    expect(result).toMatchObject({
      kind: 'selected',
      reason: 'only-standard-1899',
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

  test('defaults a new empty restore to 1899 without inventing activity', async () => {
    const result = await discoverDerivationProfile(PUBLIC_TEST_MNEMONIC, 1, {
      readAddress: discoveryReader({})
    })
    expect(result).toMatchObject({
      kind: 'selected',
      reason: 'empty',
      selectedProfileId: ECASH_STANDARD_PROFILE_ID
    })
    expect(Object.values(result.profiles).every(profile => !profile.hasActivity)).toBe(true)
  })

  test('requires explicit choice whenever more than one engine has activity', async () => {
    const result = await discoverDerivationProfile(PUBLIC_TEST_MNEMONIC, 1, {
      readAddress: discoveryReader({
        [historicalAddress]: { hasHistory: true },
        [standard1899Address]: { utxos: [utxo('c')] }
      })
    })
    expect(result.kind).toBe('choice-required')
    expect(result.reason).toBe('multi-activity')
    expect(result.selectedProfileId).toBeUndefined()
    expect(resolveProfileForMissingMetadata(result)).toBeUndefined()
    expect(resolveProfileForMissingMetadata(result, TONALLI_LEGACY_PROFILE_ID))
      .toBe(TONALLI_LEGACY_PROFILE_ID)
    expect(() => resolveProfileForMissingMetadata(result, ECASH_STANDARD_899_PROFILE_ID))
      .toThrow(/no contiene actividad/)
  })

  test('derives one account state per engine and scans all indices from public metadata', async () => {
    const deriveAccount = vi.fn(deriveAccountPublicState)
    const derivePublic = vi.fn(derivePublicMetadata)
    const readAddress = discoveryReader({})
    const result = await discoverDerivationProfile(PUBLIC_TEST_MNEMONIC, 3, {
      deriveAccountPublicState: deriveAccount,
      derivePublic,
      readAddress
    })

    expect(result.profiles[ECASH_STANDARD_PROFILE_ID].scannedAddressCount).toBe(6)
    expect(deriveAccount).toHaveBeenCalledTimes(3)
    expect(deriveAccount.mock.calls.map(call => call[1])).toEqual([
      TONALLI_LEGACY_PROFILE_ID,
      ECASH_STANDARD_899_PROFILE_ID,
      ECASH_STANDARD_PROFILE_ID
    ])
    expect(derivePublic).toHaveBeenCalledTimes(18)
    expect(readAddress).toHaveBeenCalledTimes(18)
  })

  test('resets the full gap after late historical activity', async () => {
    const lateAddress = derivePublicMetadata(historicalAccount, 'change', 2).address
    const result = await scanDerivationProfile(historicalAccount, 3, {
      readAddress: discoveryReader({ [lateAddress]: { hasHistory: true } })
    })

    expect(result.activeAddressCount).toBe(1)
    expect(result.scannedAddressCount).toBe(12)
  })

  test('treats old engine-less metadata as ambiguous and recovers read-only', async () => {
    expect(parseStoredDerivationProfileMetadata(
      '{"version":1,"derivationProfile":"tonalli-legacy-899"}'
    )).toBeNull()
    const onlyHistorical = await discoverDerivationProfile(PUBLIC_TEST_MNEMONIC, 1, {
      readAddress: discoveryReader({ [historicalAddress]: { hasHistory: true } })
    })
    expect(resolveProfileForMissingMetadata(onlyHistorical)).toBe(TONALLI_LEGACY_PROFILE_ID)
  })

  test('keeps historical legacy as the no-activity fallback for an old encrypted wallet', async () => {
    const empty = await discoverDerivationProfile(PUBLIC_TEST_MNEMONIC, 1, {
      readAddress: discoveryReader({})
    })
    expect(resolveProfileForMissingMetadata(empty)).toBe(TONALLI_LEGACY_PROFILE_ID)
  })

  test('aggregates token UTXOs by canonical token identity', () => {
    const token = {
      tokenId: 'cd'.repeat(32),
      tokenType: { protocol: 'SLP', type: 'SLP_TOKEN_TYPE_FUNGIBLE', number: 1 },
      atoms: 5n,
      isMintBaton: false
    } as NonNullable<ScriptUtxo['token']>
    expect(summarizeTokenUtxos([
      utxo('d', 546n, token),
      utxo('e', 546n, { ...token, atoms: 7n })
    ])).toEqual([{
      tokenId: token.tokenId,
      protocol: 'SLP',
      tokenType: 1,
      atoms: 12n,
      utxoCount: 2
    }])
  })
})
