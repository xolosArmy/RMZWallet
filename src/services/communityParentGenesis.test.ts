import { readFileSync } from 'node:fs'
import { Address, parseSlp, slpGenesis, toHex } from 'ecash-lib'
import { describe, expect, it } from 'vitest'
import {
  COMMUNITY_PARENT_DECIMALS,
  COMMUNITY_PARENT_DOCUMENT_HASH,
  COMMUNITY_PARENT_DUST_SATS,
  COMMUNITY_PARENT_INITIAL_QUANTITY,
  COMMUNITY_PARENT_MINT_BATON_VOUT,
  COMMUNITY_PARENT_TOKEN_NAME,
  COMMUNITY_PARENT_TOKEN_TICKER,
  COMMUNITY_PARENT_TOKEN_TYPE,
  assertCanonicalCommunityParentMetadata,
  assertCommunityParentPlannerEnvironment,
  buildCommunityParentGenesisPlan,
  formatCommunityParentGenesisPreview,
  sha256MetadataBytes
} from './communityParentGenesis'
import type {
  CommunityParentFundingUtxo,
  CommunityParentGenesisConfig
} from './communityParentGenesis'

const FUNDING_ADDRESS = 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk'
const TOKEN_ADDRESS = 'ecash:qplm2jhzuteklx9naquzwfe97tx3h8eu4gyq385tw8'
const BATON_ADDRESS = 'ecash:qpluxjhhlxfjwsymf9nmctvsdrwzwygadsh2pq0ang'
const CHANGE_ADDRESS = 'ecash:qpnku5pz7h29jkpga99py72gnrksaalzscrjnwnzvt'
const CID_V0 = 'QmRmMkmm5Aouw9iEQ3APoab5DjhKkUVdLGT6iv9BwjVkao'
const CID_V1 = 'bafybeibs45utqwgtmxascm272fnbkgq2n45pdwzl4nlnfvcl7ptfhoqs6q'
const DOCUMENT_URI = `ipfs://${CID_V1}`
const METADATA_BYTES = new Uint8Array(
  readFileSync(new URL('../../scripts/metadata/community-parent.json', import.meta.url))
)
const FUNDING_SCRIPT = toHex(Address.parse(FUNDING_ADDRESS).toScript().bytecode)

const makeUtxo = (
  params: Partial<CommunityParentFundingUtxo> & { token?: unknown } = {}
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

describe('canonical community Parent SLP NFT1 Group semantics', () => {
  it('builds the exact canonical type-129 GENESIS and fixed output layout', () => {
    const plan = buildPlan()
    const expectedOpReturn = slpGenesis(
      COMMUNITY_PARENT_TOKEN_TYPE,
      {
        tokenTicker: COMMUNITY_PARENT_TOKEN_TICKER,
        tokenName: COMMUNITY_PARENT_TOKEN_NAME,
        url: DOCUMENT_URI,
        hash: COMMUNITY_PARENT_DOCUMENT_HASH,
        decimals: COMMUNITY_PARENT_DECIMALS
      },
      COMMUNITY_PARENT_INITIAL_QUANTITY,
      COMMUNITY_PARENT_MINT_BATON_VOUT
    )
    expect(parseSlp(expectedOpReturn)).toEqual({
      txType: 'GENESIS',
      tokenType: 129,
      genesisInfo: {
        tokenTicker: 'RMZCOMM',
        tokenName: 'xolosArmy Community',
        url: DOCUMENT_URI,
        hash: COMMUNITY_PARENT_DOCUMENT_HASH,
        decimals: 0,
        mintVaultScripthash: undefined
      },
      initialAtoms: 1n,
      mintBatonOutIdx: 2
    })
    expect(plan.opReturnHex).toBe(toHex(expectedOpReturn.bytecode))
    expect(plan.outputs.slice(0, 3)).toEqual([
      {
        vout: 0,
        kind: 'slp-genesis',
        sats: 0n,
        scriptHex: plan.opReturnHex
      },
      {
        vout: 1,
        kind: 'initial-group-quantity',
        sats: COMMUNITY_PARENT_DUST_SATS,
        scriptHex: toHex(Address.parse(TOKEN_ADDRESS).toScript().bytecode),
        address: TOKEN_ADDRESS,
        tokenAtoms: 1n
      },
      {
        vout: 2,
        kind: 'mint-baton',
        sats: COMMUNITY_PARENT_DUST_SATS,
        scriptHex: toHex(Address.parse(BATON_ADDRESS).toScript().bytecode),
        address: BATON_ADDRESS
      }
    ])
    expect(plan.outputs[3]).toMatchObject({
      vout: 3,
      kind: 'xec-change',
      address: CHANGE_ADDRESS
    })
  })

  it.each([0n, 2n, 1000n, -1n, 1.5])(
    'does not expose initial quantity %s as a configurable builder input',
    (attemptedQuantity) => {
      const hostileConfig = {
        ...makeConfig(),
        initialQuantity: attemptedQuantity
      } as CommunityParentGenesisConfig
      const plan = buildCommunityParentGenesisPlan({
        config: hostileConfig,
        fundingUtxos: [makeUtxo()]
      })
      expect(plan.initialQuantity).toBe(1n)
      expect(plan.outputs[1].tokenAtoms).toBe(1n)
    }
  )

  it('does not expose token type, decimals, name, ticker, hash, or baton index as inputs', () => {
    const hostileConfig = {
      ...makeConfig(),
      tokenType: 1,
      decimals: 9,
      tokenName: 'Other',
      tokenTicker: 'OTHER',
      documentHash: '00'.repeat(32),
      mintBatonVout: 9
    } as CommunityParentGenesisConfig
    const plan = buildCommunityParentGenesisPlan({
      config: hostileConfig,
      fundingUtxos: [makeUtxo()]
    })
    expect(plan).toMatchObject({
      tokenType: 129,
      decimals: 0,
      tokenName: 'xolosArmy Community',
      tokenTicker: 'RMZCOMM',
      documentHash: COMMUNITY_PARENT_DOCUMENT_HASH,
      mintBatonVout: 2
    })
  })
})

describe('canonical metadata and IPFS document URI', () => {
  it('binds the exact checked-in bytes to the frozen document hash', () => {
    expect(sha256MetadataBytes(METADATA_BYTES)).toBe(COMMUNITY_PARENT_DOCUMENT_HASH)
    expect(() => assertCanonicalCommunityParentMetadata(METADATA_BYTES)).not.toThrow()
    expect(buildPlan().documentHash).toBe(COMMUNITY_PARENT_DOCUMENT_HASH)
  })

  it('rejects a one-byte mutation even if a caller can recalculate its hash', () => {
    const mutated = METADATA_BYTES.slice()
    const marker = new TextEncoder().encode('Burn one pass')
    const offset = Buffer.from(mutated).indexOf(Buffer.from(marker))
    expect(offset).toBeGreaterThanOrEqual(0)
    mutated[offset] = 'b'.charCodeAt(0)
    expect(sha256MetadataBytes(mutated)).not.toBe(COMMUNITY_PARENT_DOCUMENT_HASH)
    expect(() => assertCanonicalCommunityParentMetadata(mutated)).toThrow(/canonical/)
  })

  it('rejects metadata that changes the reviewed verification posture', () => {
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
    expect(() => assertCanonicalCommunityParentMetadata(hostile)).toThrow(/unverified/)
  })

  it.each([CID_V0, CID_V1])('accepts a canonical IPFS CID: %s', (cid) => {
    expect(buildPlan({ config: { documentUri: `ipfs://${cid}` } }).documentUri).toBe(`ipfs://${cid}`)
  })

  it.each([
    'ipfs://00000000000000000000',
    'ipfs://not-a-cid',
    'https://example.com/foo',
    'ipfs://',
    'ipfs://b%%%',
    `ipfs://${CID_V1.toUpperCase()}`,
    `ipfs://${CID_V1}/metadata.json`,
    `ipfs://${CID_V1}?download=1`
  ])('rejects a malformed or non-canonical IPFS URI: %s', (documentUri) => {
    expect(() => buildPlan({ config: { documentUri } })).toThrow(/IPFS|ipfs/)
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

describe('pure-XEC funding snapshot validation', () => {
  it.each([
    { protocol: 'SLP', tokenType: 1, atoms: 1n, isMintBaton: false },
    { protocol: 'SLP', tokenType: 65, atoms: 1n, isMintBaton: false },
    { protocol: 'SLP', tokenType: 129, atoms: 1n, isMintBaton: false },
    { protocol: 'SLP', tokenType: 129, atoms: 0n, isMintBaton: true },
    { protocol: 'ALP', tokenType: 0, atoms: 1n, isMintBaton: false }
  ])('rejects a token-bearing funding UTXO: $protocol/$tokenType', (token) => {
    expect(() => buildPlan({ utxos: [makeUtxo({ token })] })).toThrow(/Token-bearing UTXOs/)
  })

  it('accepts the maximum uint32 outIdx and rejects values outside uint32', () => {
    expect(buildPlan({
      utxos: [makeUtxo({ outpoint: { txid: '11'.repeat(32), outIdx: 0xffffffff } })]
    }).selectedInputs[0].outpoint.outIdx).toBe(0xffffffff)
    for (const outIdx of [-1, 0x100000000, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(() => buildPlan({
        utxos: [makeUtxo({ outpoint: { txid: '11'.repeat(32), outIdx } })]
      })).toThrow(/outpoint/)
    }
  })

  it('rejects malformed txids and funding not controlled by the funding address', () => {
    expect(() => buildPlan({
      utxos: [makeUtxo({ outpoint: { txid: 'AA'.repeat(32), outIdx: 0 } })]
    })).toThrow(/outpoint/)
    const wrongScript = toHex(Address.parse(TOKEN_ADDRESS).toScript().bytecode)
    expect(() => buildPlan({ utxos: [makeUtxo({ outputScript: wrongScript })] })).toThrow(/not controlled/)
  })

  it('rejects insufficient, duplicate, and coinbase funding', () => {
    expect(() => buildPlan({ utxos: [makeUtxo({ sats: 100n })] })).toThrow(/Insufficient/)
    const duplicate = makeUtxo()
    expect(() => buildPlan({ utxos: [duplicate, duplicate] })).toThrow(/Duplicate/)
    expect(() => buildPlan({
      utxos: [makeUtxo({ isCoinbase: true as never })]
    })).toThrow(/Coinbase/)
  })
})

describe('planner-only capability boundary', () => {
  it('accepts a normal offline environment and rejects either former broadcast flag', () => {
    expect(() => assertCommunityParentPlannerEnvironment({})).not.toThrow()
    expect(() => assertCommunityParentPlannerEnvironment({ BROADCAST: '1' })).toThrow(/not supported/)
    expect(() => assertCommunityParentPlannerEnvironment({
      CONFIRM_COMMUNITY_PARENT_GENESIS: 'YES'
    })).toThrow(/not supported/)
    expect(() => assertCommunityParentPlannerEnvironment({
      BROADCAST: '1',
      CONFIRM_COMMUNITY_PARENT_GENESIS: 'YES'
    })).toThrow(/not supported/)
  })

  it('formats a complete offline preview without secret material', () => {
    const preview = formatCommunityParentGenesisPreview(buildPlan())
    expect(preview).toContain('mode: DRY_RUN')
    expect(preview).toContain('tokenType: 129 (SLP NFT1 Group)')
    expect(preview).toContain(`documentHash: ${COMMUNITY_PARENT_DOCUMENT_HASH}`)
    expect(preview).toContain('selectedPureXecInputs:')
    expect(preview).toContain('expectedOutputs:')
    expect(preview).toContain('broadcastExecuted: NO')
    expect(preview).not.toMatch(/WIF|mnemonic|privateKey|seed/i)
  })

  it('keeps the CLI offline and validates the checked-in metadata before planning', () => {
    const cliSource = readFileSync(
      new URL('../../scripts/create-community-parent.ts', import.meta.url),
      'utf8'
    )
    expect(cliSource).toContain('assertCanonicalCommunityParentMetadata(metadataBytes)')
    expect(cliSource).toContain('assertCommunityParentPlannerEnvironment')
    expect(cliSource).not.toMatch(/getChronik|ChronikClient|broadcastTx|Pinata|mnemonic|privateKey|WIF|seed/)
    expect(cliSource).not.toMatch(/executeCommunityParentGenesis|signingSecretAvailable|ports:/)
    expect(cliSource).not.toMatch(/process\.env\.COMMUNITY_PARENT_INITIAL_QUANTITY/)
  })

  it('contains no signer, broadcaster, executor, live revalidation, policy, extractor, or UI capability', () => {
    const builderSource = readFileSync(new URL('./communityParentGenesis.ts', import.meta.url), 'utf8')
    expect(builderSource).not.toMatch(/NFT_COLLECTIONS|classifyCollection|nftEvidenceExtractor|React/)
    expect(builderSource).not.toMatch(/executeCommunityParentGenesis|signingSecretAvailable|revalidateFunding/)
    expect(builderSource).not.toMatch(/ports\.sign|ports\.broadcast|broadcastTx|TxBuilder|P2PKHSignatory/)
  })
})
