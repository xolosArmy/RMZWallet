import type { ScriptUtxo } from 'chronik-client'
import {
  DERIVATION_PROFILE_IDS,
  ECASH_STANDARD_PROFILE_ID,
  TONALLI_LEGACY_PROFILE_ID,
  deriveAccountXpub,
  deriveWatchOnlyMetadata
} from './derivationProfiles'
import type {
  AccountXpub,
  DerivationProfileId,
  PublicDerivationMetadata
} from './derivationProfiles'

export type DiscoveredTokenAsset = Readonly<{
  tokenId: string
  protocol: string
  tokenType: number
  atoms: bigint
  utxoCount: number
}>

export type AddressDiscoverySnapshot = Readonly<{
  utxos: readonly ScriptUtxo[]
  hasHistory: boolean
}>

export type DerivationProfileActivity = Readonly<{
  profileId: DerivationProfileId
  hasActivity: boolean
  xecSats: bigint
  tokenUtxoCount: number
  activeAddressCount: number
  scannedAddressCount: number
  tokens: readonly DiscoveredTokenAsset[]
}>

export type DerivationDiscovery = Readonly<{
  kind: 'selected' | 'choice-required'
  reason: 'only-legacy' | 'only-standard' | 'empty' | 'dual-activity'
  selectedProfileId?: DerivationProfileId
  profiles: Readonly<Record<DerivationProfileId, DerivationProfileActivity>>
}>

export type DerivationDiscoveryDependencies = Readonly<{
  readAddress(address: string): Promise<AddressDiscoverySnapshot>
  deriveAccountXpub?: (
    mnemonic: string,
    profileId: DerivationProfileId
  ) => AccountXpub
  deriveWatchOnly?: (
    accountXpub: AccountXpub,
    branch: PublicDerivationMetadata['branch'],
    index: number
  ) => PublicDerivationMetadata
}>

export function summarizeTokenUtxos(utxos: readonly ScriptUtxo[]): readonly DiscoveredTokenAsset[] {
  const assets = new Map<string, {
    tokenId: string
    protocol: string
    tokenType: number
    atoms: bigint
    utxoCount: number
  }>()

  for (const utxo of utxos) {
    const token = utxo.token
    if (!token) continue
    const key = `${token.tokenId}:${token.tokenType.protocol}:${token.tokenType.number}`
    const current = assets.get(key) ?? {
      tokenId: token.tokenId,
      protocol: token.tokenType.protocol,
      tokenType: token.tokenType.number,
      atoms: 0n,
      utxoCount: 0
    }
    current.atoms += token.atoms
    current.utxoCount += 1
    assets.set(key, current)
  }

  return Object.freeze(
    [...assets.values()]
      .sort((a, b) => a.tokenId.localeCompare(b.tokenId) || a.protocol.localeCompare(b.protocol))
      .map(asset => Object.freeze({ ...asset }))
  )
}

export async function scanDerivationProfile(
  accountXpub: AccountXpub,
  gapLimit: number,
  dependencies: DerivationDiscoveryDependencies
): Promise<DerivationProfileActivity> {
  if (!Number.isSafeInteger(gapLimit) || gapLimit <= 0) {
    throw new Error('El gap limit de autodetección debe ser un entero positivo.')
  }

  const derive = dependencies.deriveWatchOnly ?? deriveWatchOnlyMetadata
  const snapshots: Array<Readonly<{
    metadata: PublicDerivationMetadata
    snapshot: AddressDiscoverySnapshot
  }>> = []
  let consecutiveUnused = 0
  let index = 0

  // Match Tonalli's HD scanner semantics: stop only after a complete gap of
  // inactive indices, resetting the gap when either receive or change has
  // history/UTXOs. Both branches are queried concurrently.
  while (consecutiveUnused < gapLimit) {
    const metadata = [
      derive(accountXpub, 'receive', index),
      derive(accountXpub, 'change', index)
    ] as const
    const pair = await Promise.all(metadata.map(async entry => Object.freeze({
      metadata: entry,
      snapshot: await dependencies.readAddress(entry.address)
    })))
    snapshots.push(...pair)
    const hasActivity = pair.some(({ snapshot }) =>
      snapshot.hasHistory || snapshot.utxos.length > 0
    )
    consecutiveUnused = hasActivity ? 0 : consecutiveUnused + 1
    index += 1
  }
  const allUtxos = snapshots.flatMap(({ snapshot }) => [...snapshot.utxos])
  const tokens = summarizeTokenUtxos(allUtxos)
  const activeAddressCount = snapshots.filter(({ snapshot }) =>
    snapshot.hasHistory || snapshot.utxos.length > 0
  ).length

  return Object.freeze({
    profileId: accountXpub.profileId,
    hasActivity: activeAddressCount > 0,
    xecSats: allUtxos.reduce((total, utxo) => total + utxo.sats, 0n),
    tokenUtxoCount: tokens.reduce((total, token) => total + token.utxoCount, 0),
    activeAddressCount,
    scannedAddressCount: snapshots.length,
    tokens
  })
}

export function selectDerivationProfile(
  legacy: DerivationProfileActivity,
  standard: DerivationProfileActivity
): DerivationDiscovery {
  const profiles = Object.freeze({
    [TONALLI_LEGACY_PROFILE_ID]: legacy,
    [ECASH_STANDARD_PROFILE_ID]: standard
  })

  if (legacy.hasActivity && standard.hasActivity) {
    return Object.freeze({ kind: 'choice-required', reason: 'dual-activity', profiles })
  }
  if (legacy.hasActivity) {
    return Object.freeze({
      kind: 'selected',
      reason: 'only-legacy',
      selectedProfileId: TONALLI_LEGACY_PROFILE_ID,
      profiles
    })
  }
  if (standard.hasActivity) {
    return Object.freeze({
      kind: 'selected',
      reason: 'only-standard',
      selectedProfileId: ECASH_STANDARD_PROFILE_ID,
      profiles
    })
  }
  return Object.freeze({
    kind: 'selected',
    reason: 'empty',
    selectedProfileId: ECASH_STANDARD_PROFILE_ID,
    profiles
  })
}

/**
 * Resolve an encrypted wallet whose profile metadata is absent or invalid.
 * A truly empty historical wallet keeps Tonalli's legacy fallback; a detected
 * profile (or explicit dual-activity choice) is authoritative.
 */
export function resolveProfileForMissingMetadata(
  detection: DerivationDiscovery,
  selectedProfileId?: DerivationProfileId
): DerivationProfileId | undefined {
  if (detection.kind === 'choice-required') {
    if (selectedProfileId === undefined) return undefined
    if (!DERIVATION_PROFILE_IDS.includes(selectedProfileId)) {
      throw new Error('El perfil solicitado para recuperación no es válido.')
    }
    return selectedProfileId
  }

  if (selectedProfileId !== undefined && selectedProfileId !== detection.selectedProfileId) {
    throw new Error('El perfil solicitado no coincide con la actividad detectada.')
  }
  if (detection.reason === 'empty') return TONALLI_LEGACY_PROFILE_ID
  return detection.selectedProfileId
}

export async function discoverDerivationProfile(
  mnemonic: string,
  gapLimit: number,
  dependencies: DerivationDiscoveryDependencies
): Promise<DerivationDiscovery> {
  const deriveAccount = dependencies.deriveAccountXpub ?? deriveAccountXpub
  const accountXpubs = DERIVATION_PROFILE_IDS.map(profileId =>
    deriveAccount(mnemonic, profileId)
  )
  const results = await Promise.all(
    accountXpubs.map(accountXpub =>
      scanDerivationProfile(accountXpub, gapLimit, dependencies)
    )
  )
  const legacy = results.find(result => result.profileId === TONALLI_LEGACY_PROFILE_ID)
  const standard = results.find(result => result.profileId === ECASH_STANDARD_PROFILE_ID)
  if (!legacy || !standard) throw new Error('No se pudieron evaluar ambos perfiles de derivación.')
  return selectDerivationProfile(legacy, standard)
}
