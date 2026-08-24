import { readFileSync } from 'node:fs'
import { Address, parseSlp, slpGenesis, toHex } from 'ecash-lib'
import { describe, expect, it, vi } from 'vitest'
import {
  COMMUNITY_PARENT_DECIMALS,
  COMMUNITY_PARENT_DUST_SATS,
  COMMUNITY_PARENT_INITIAL_QUANTITY,
  COMMUNITY_PARENT_MINT_BATON_VOUT,
  COMMUNITY_PARENT_TOKEN_NAME,
  COMMUNITY_PARENT_TOKEN_TICKER,
  COMMUNITY_PARENT_TOKEN_TYPE,
  buildCommunityParentGenesisPlan,
  executeCommunityParentGenesis,
  formatCommunityParentGenesisPreview,
  isCommunityParentBroadcastEnabled,
  revalidateCommunityParentFunding,
  sha256MetadataBytes,
  validateCommunityParentInitialQuantity
} from './communityParentGenesis'
import type {
  CommunityParentFundingUtxo,
  CommunityParentGenesisConfig
} from './communityParentGenesis'

const FUNDING_ADDRESS = 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk'
const TOKEN_ADDRESS = 'ecash:qplm2jhzuteklx9naquzwfe97tx3h8eu4gyq385tw8'
const BATON_ADDRESS = 'ecash:qpluxjhhlxfjwsymf9nmctvsdrwzwygadsh2pq0ang'
const CHANGE_ADDRESS = 'ecash:qpnku5pz7h29jkpga99py72gnrksaalzscrjnwnzvt'
const DOCUMENT_URI = `ipfs://bafy${'a'.repeat(52)}`
const METADATA_BYTES = new Uint8Array(
  readFileSync(new URL('../../scripts/metadata/community-parent.json', import.meta.url))
)
const DOCUMENT_HASH = sha256MetadataBytes(METADATA_BYTES)
const FUNDING_SCRIPT = toHex(Address.parse(FUNDING_ADDRESS).toScript().bytecode)

const makeUtxo = (
  params: Partial<CommunityParentFundingUtxo> & {
    token?: unknown
  } = {}
): CommunityParentFundingUtxo => ({
  outpoint: params.outpoint ?? { txid: '11'.repeat(32), outIdx: 0 },
  sats: params.sats ?? 10_000n,
  outputScript: params.outputScript ?? FUNDING_SCRIPT,
  isCoinbase: params.isCoinbase ?? false,
  ...(Object.prototype.hasOwnProperty.call(params, 'token') ? { token: params.token } : {})
})

const makeConfig = (
  overrides: Partial<CommunityParentGenesisConfig> = {}
): CommunityParentGenesisConfig => ({
  network: 'mainnet',
  fundingAddress: FUNDING_ADDRESS,
  tokenDestinationAddress: TOKEN_ADDRESS,
  batonDestinationAddress: BATON_ADDRESS,
  changeAddress: CHANGE_ADDRESS,
  documentUri: DOCUMENT_URI,
  documentHash: DOCUMENT_HASH,
  metadataBytes: METADATA_BYTES,
  tokenType: COMMUNITY_PARENT_TOKEN_TYPE,
  tokenName: COMMUNITY_PARENT_TOKEN_NAME,
  tokenTicker: COMMUNITY_PARENT_TOKEN_TICKER,
  decimals: COMMUNITY_PARENT_DECIMALS,
  initialQuantity: COMMUNITY_PARENT_INITIAL_QUANTITY,
  ...overrides
})

const buildPlan = (params: {
  config?: Partial<CommunityParentGenesisConfig>
  utxos?: readonly CommunityParentFundingUtxo[]
} = {}) =>
  buildCommunityParentGenesisPlan({
    config: makeConfig(params.config),
    fundingUtxos: params.utxos ?? [makeUtxo()]
  })

describe('community Parent SLP NFT1 Group semantics', () => {
  it('builds the exact type-129 GENESIS with quantity output, retained baton, and existing dust policy', () => {
    const plan = buildPlan()
    const expectedOpReturn = slpGenesis(
      plan.tokenType,
      {
        tokenTicker: plan.tokenTicker,
        tokenName: plan.tokenName,
        url: plan.documentUri,
        hash: plan.documentHash,
        decimals: plan.decimals
      },
      plan.initialQuantity,
      plan.mintBatonVout
    )
    const decoded = parseSlp(expectedOpReturn)

    expect(decoded).toEqual({
      txType: 'GENESIS',
      tokenType: 129,
      genesisInfo: {
        tokenTicker: COMMUNITY_PARENT_TOKEN_TICKER,
        tokenName: COMMUNITY_PARENT_TOKEN_NAME,
        url: DOCUMENT_URI,
        hash: DOCUMENT_HASH,
        decimals: 0,
        mintVaultScripthash: undefined
      },
      initialAtoms: 1n,
      mintBatonOutIdx: 2
    })
    expect(plan.opReturnHex).toBe(toHex(expectedOpReturn.bytecode))
    expect(plan.outputs.slice(0, 3)).toMatchObject([
      { vout: 0, kind: 'slp-genesis', sats: 0n },
      {
        vout: 1,
        kind: 'initial-group-quantity',
        sats: COMMUNITY_PARENT_DUST_SATS,
        tokenAtoms: 1n,
        address: TOKEN_ADDRESS
      },
      {
        vout: 2,
        kind: 'mint-baton',
        sats: COMMUNITY_PARENT_DUST_SATS,
        address: BATON_ADDRESS
      }
    ])
    expect(plan.outputs[3]).toMatchObject({
      vout: 3,
      kind: 'xec-change',
      address: CHANGE_ADDRESS
    })
  })

  it('documents that ecash-lib can encode zero atoms while this tool rejects zero as unsafe', () => {
    const zeroGenesis = slpGenesis(
      COMMUNITY_PARENT_TOKEN_TYPE,
      {
        tokenTicker: COMMUNITY_PARENT_TOKEN_TICKER,
        tokenName: COMMUNITY_PARENT_TOKEN_NAME,
        url: DOCUMENT_URI,
        hash: DOCUMENT_HASH,
        decimals: 0
      },
      0n,
      COMMUNITY_PARENT_MINT_BATON_VOUT
    )
    expect(parseSlp(zeroGenesis)).toMatchObject({
      txType: 'GENESIS',
      tokenType: 129,
      initialAtoms: 0n,
      mintBatonOutIdx: 2
    })
    expect(() => buildPlan({ config: { initialQuantity: 0n } })).toThrow(/between 1/)
  })

  it('rejects any token type other than SLP NFT1 Group 129', () => {
    expect(() => buildPlan({ config: { tokenType: 1 } })).toThrow(/type 129/)
    expect(() => buildPlan({ config: { tokenType: 65 } })).toThrow(/type 129/)
  })

  it('rejects non-zero decimals', () => {
    expect(() => buildPlan({ config: { decimals: 1 } })).toThrow(/zero decimals/)
  })

  it.each([
    -1n,
    0n,
    0,
    1,
    Number.NaN,
    1.5,
    '',
    '0',
    '01',
    ' 1',
    '1 ',
    '1.0',
    '1e3',
    '18446744073709551616'
  ])('rejects invalid or ambiguous initial quantity %s', (quantity) => {
    expect(() => validateCommunityParentInitialQuantity(quantity)).toThrow()
  })

  it('accepts only explicit positive decimal strings or bigint quantities', () => {
    expect(validateCommunityParentInitialQuantity('1')).toBe(1n)
    expect(validateCommunityParentInitialQuantity(2n)).toBe(2n)
  })
})

describe('metadata and administrative parameters', () => {
  it('binds the exact checked-in metadata bytes to the SLP document hash', () => {
    const plan = buildPlan()
    expect(plan.documentHash).toBe(DOCUMENT_HASH)
    expect(plan.documentHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects a missing or non-IPFS document URI', () => {
    expect(() => buildPlan({ config: { documentUri: '' } })).toThrow(/ipfs/)
    expect(() => buildPlan({ config: { documentUri: 'https://example.com/metadata.json' } })).toThrow(/ipfs/)
  })

  it('rejects a metadata hash mismatch', () => {
    expect(() => buildPlan({ config: { documentHash: '00'.repeat(32) } })).toThrow(/does not match/)
  })

  it('rejects metadata that claims a different verification posture', () => {
    const hostile = new TextEncoder().encode(
      JSON.stringify({
        schema: 'xolosarmy-nft/1',
        collection: {
          type: 'community',
          verification: 'verified',
          name: COMMUNITY_PARENT_TOKEN_NAME
        }
      })
    )
    expect(() =>
      buildPlan({
        config: { metadataBytes: hostile, documentHash: sha256MetadataBytes(hostile) }
      })
    ).toThrow(/descriptive, unverified/)
  })

  it('preserves distinct funding, token, baton, and change destinations', () => {
    const plan = buildPlan()
    expect(new Set([
      plan.fundingAddress,
      plan.tokenDestinationAddress,
      plan.batonDestinationAddress,
      plan.changeAddress
    ]).size).toBe(4)
  })

  it('rejects implicit or mismatched networks', () => {
    expect(() => buildPlan({ config: { network: 'regtest' } })).toThrow(/explicit regtest/)
    expect(() =>
      buildPlan({ config: { network: 'staging' as CommunityParentGenesisConfig['network'] } })
    ).toThrow(/explicitly set/)
  })
})

describe('pure-XEC funding and revalidation', () => {
  it.each([
    { protocol: 'SLP', tokenType: 1, atoms: 1n, isMintBaton: false },
    { protocol: 'SLP', tokenType: 65, atoms: 1n, isMintBaton: false },
    { protocol: 'SLP', tokenType: 129, atoms: 1n, isMintBaton: false },
    { protocol: 'SLP', tokenType: 129, atoms: 0n, isMintBaton: true },
    { protocol: 'ALP', tokenType: 0, atoms: 1n, isMintBaton: false }
  ])('rejects a token-bearing funding UTXO: $protocol/$tokenType', (token) => {
    expect(() => buildPlan({ utxos: [makeUtxo({ token })] })).toThrow(/Token-bearing UTXOs/)
  })

  it('rejects funding not controlled by the explicit funding address', () => {
    const wrongScript = toHex(Address.parse(TOKEN_ADDRESS).toScript().bytecode)
    expect(() => buildPlan({ utxos: [makeUtxo({ outputScript: wrongScript })] })).toThrow(/not controlled/)
  })

  it('rejects insufficient, duplicate, and coinbase funding', () => {
    expect(() => buildPlan({ utxos: [makeUtxo({ sats: 100n })] })).toThrow(/Insufficient/)
    const duplicate = makeUtxo()
    expect(() => buildPlan({ utxos: [duplicate, duplicate] })).toThrow(/Duplicate/)
    expect(() =>
      buildPlan({
        utxos: [makeUtxo({ isCoinbase: true as never })]
      })
    ).toThrow(/Coinbase/)
  })

  it('fails closed if a selected UTXO disappears, changes amount, or gains a token annotation', () => {
    const selected = [makeUtxo()]
    expect(() => revalidateCommunityParentFunding(selected, [])).toThrow(/disappeared/)
    expect(() =>
      revalidateCommunityParentFunding(selected, [makeUtxo({ sats: 9_999n })])
    ).toThrow(/amount changed/)
    expect(() =>
      revalidateCommunityParentFunding(selected, [makeUtxo({ token: { isMintBaton: true } })])
    ).toThrow(/Token-bearing/)
  })

  it('accepts an exact fresh pure-XEC snapshot', () => {
    const selected = [makeUtxo()]
    expect(() => revalidateCommunityParentFunding(selected, [makeUtxo()])).not.toThrow()
  })
})

describe('dry-run and future broadcast gates', () => {
  it.each([
    {},
    { BROADCAST: '1' },
    { CONFIRM_COMMUNITY_PARENT_GENESIS: 'YES' },
    { BROADCAST: 'true', CONFIRM_COMMUNITY_PARENT_GENESIS: 'YES' },
    { BROADCAST: '1', CONFIRM_COMMUNITY_PARENT_GENESIS: 'yes' }
  ])('keeps execution in dry-run unless both exact gates are present: %o', async (environment) => {
    const plan = buildPlan()
    const result = await executeCommunityParentGenesis({
      plan,
      environment,
      signingSecretAvailable: false
    })
    expect(result).toEqual({ mode: 'dry-run', plan })
  })

  it('requires both exact broadcast gates', () => {
    expect(isCommunityParentBroadcastEnabled({
      BROADCAST: '1',
      CONFIRM_COMMUNITY_PARENT_GENESIS: 'YES'
    })).toBe(true)
    expect(isCommunityParentBroadcastEnabled({ BROADCAST: '1' })).toBe(false)
    expect(isCommunityParentBroadcastEnabled({ CONFIRM_COMMUNITY_PARENT_GENESIS: 'YES' })).toBe(false)
  })

  it('fails closed before revalidation, signing, or broadcast when no signing secret is available', async () => {
    const revalidateFunding = vi.fn()
    const sign = vi.fn()
    const broadcast = vi.fn()
    await expect(
      executeCommunityParentGenesis({
        plan: buildPlan(),
        environment: {
          BROADCAST: '1',
          CONFIRM_COMMUNITY_PARENT_GENESIS: 'YES'
        },
        signingSecretAvailable: false,
        ports: { revalidateFunding, sign, broadcast }
      })
    ).rejects.toThrow(/no signing secret/)
    expect(revalidateFunding).not.toHaveBeenCalled()
    expect(sign).not.toHaveBeenCalled()
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('formats a complete safe preview without secret material', () => {
    const preview = formatCommunityParentGenesisPreview(buildPlan())
    expect(preview).toContain('mode: DRY_RUN')
    expect(preview).toContain('tokenType: 129 (SLP NFT1 Group)')
    expect(preview).toContain(`documentHash: ${DOCUMENT_HASH}`)
    expect(preview).toContain('selectedPureXecInputs:')
    expect(preview).toContain('expectedOutputs:')
    expect(preview).toContain('estimatedFeeSats:')
    expect(preview).toContain('broadcastExecuted: NO')
    expect(preview).not.toMatch(/WIF|mnemonic|privateKey|seed/i)
  })
})

describe('scope isolation', () => {
  it('keeps the CLI offline by default and free of concrete Chronik, wallet, or Pinata wiring', () => {
    const cliSource = readFileSync(
      new URL('../../scripts/create-community-parent.ts', import.meta.url),
      'utf8'
    )
    expect(cliSource).not.toMatch(/getChronik|ChronikClient|broadcastTx|Pinata|mnemonic|privateKey|WIF|seed/)
    expect(cliSource).toContain('signingSecretAvailable: false')
  })

  it('does not import collection policy, classifier, extractor, or UI into the builder', () => {
    const builderSource = readFileSync(new URL('./communityParentGenesis.ts', import.meta.url), 'utf8')
    expect(builderSource).not.toMatch(/NFT_COLLECTIONS|classifyCollection|nftEvidenceExtractor|React/)
    expect(builderSource).toMatch(
      /await params\.ports\.revalidateFunding\(\)[\s\S]+revalidateCommunityParentFunding[\s\S]+await params\.ports\.sign[\s\S]+await params\.ports\.broadcast/
    )
  })
})
