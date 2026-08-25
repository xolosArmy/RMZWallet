import { readFileSync } from 'node:fs'
import { Address, Script, Tx, toHex } from 'ecash-lib'
import { describe, expect, it, vi } from 'vitest'
import {
  COMMUNITY_PARENT_DOCUMENT_HASH,
  COMMUNITY_PARENT_INITIAL_QUANTITY,
  COMMUNITY_PARENT_MINT_BATON_VOUT,
  COMMUNITY_PARENT_TOKEN_NAME,
  COMMUNITY_PARENT_TOKEN_TICKER,
  COMMUNITY_PARENT_TOKEN_TYPE
} from './communityParentGenesis'
import type {
  CommunityParentGenesisConfig,
  CommunityParentNetwork
} from './communityParentGenesis'
import {
  executeCommunityParentGenesis,
  formatCommunityParentExecutionPreview,
  prepareCommunityParentExecution
} from './communityParentExecutor'
import type {
  CommunityParentChronikReader,
  CommunityParentExecutionCandidate
} from './communityParentExecutor'

const FUNDING_ADDRESS = 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk'
const TOKEN_ADDRESS = 'ecash:qplm2jhzuteklx9naquzwfe97tx3h8eu4gyq385tw8'
const BATON_ADDRESS = 'ecash:qpluxjhhlxfjwsymf9nmctvsdrwzwygadsh2pq0ang'
const CHANGE_ADDRESS = 'ecash:qpnku5pz7h29jkpga99py72gnrksaalzscrjnwnzvt'
const DOCUMENT_URI = 'ipfs://bafybeibs45utqwgtmxascm272fnbkgq2n45pdwzl4nlnfvcl7ptfhoqs6q'
const FUNDING_SCRIPT = toHex(Address.parse(FUNDING_ADDRESS).toScript().bytecode)
const ENDPOINT = 'https://chronik.e.cash,https://chronik.xolosarmy.xyz'

type LiveUtxo = {
  readonly outpoint: { readonly txid: string; readonly outIdx: number }
  readonly sats: bigint
  readonly isCoinbase: boolean
  readonly token?: unknown
}

const liveUtxo = (overrides: Partial<LiveUtxo> & { token?: unknown } = {}): LiveUtxo => ({
  outpoint: overrides.outpoint ?? { txid: '11'.repeat(32), outIdx: 0 },
  sats: overrides.sats ?? 10_000n,
  isCoinbase: overrides.isCoinbase ?? false,
  ...(Object.prototype.hasOwnProperty.call(overrides, 'token') ? { token: overrides.token } : {})
})

const liveResponse = (
  utxos: readonly LiveUtxo[] = [liveUtxo()],
  outputScript = FUNDING_SCRIPT
): unknown => ({ outputScript, utxos })

const addressFor = (address: string, network: CommunityParentNetwork): string => {
  const prefix = network === 'mainnet' ? 'ecash' : network === 'testnet' ? 'ectest' : 'ecregtest'
  return Address.parse(address).withPrefix(prefix).toString()
}

const configFor = (
  network: CommunityParentNetwork = 'mainnet',
  overrides: Partial<CommunityParentGenesisConfig> = {}
): CommunityParentGenesisConfig => ({
  network,
  fundingAddress: addressFor(FUNDING_ADDRESS, network),
  tokenDestinationAddress: addressFor(TOKEN_ADDRESS, network),
  batonDestinationAddress: addressFor(BATON_ADDRESS, network),
  changeAddress: addressFor(CHANGE_ADDRESS, network),
  documentUri: DOCUMENT_URI,
  ...overrides
})

class MockReader implements CommunityParentChronikReader {
  readonly endpointLabel = ENDPOINT
  readonly addressCalls: string[] = []
  readonly validateCalls: Uint8Array[] = []
  readonly txCalls: string[] = []
  private readonly responses: unknown[]
  validateImpl: (rawTx: Uint8Array) => Promise<unknown> = async () => {
    throw new Error('validateRawTx mock not configured')
  }
  txImpl: (txid: string) => Promise<unknown> = async () => {
    throw new Error('tx mock not configured')
  }

  constructor(...responses: unknown[]) {
    this.responses = responses.length === 0 ? [liveResponse()] : responses
  }

  async addressUtxos(address: string): Promise<unknown> {
    this.addressCalls.push(address)
    const index = Math.min(this.addressCalls.length - 1, this.responses.length - 1)
    return this.responses[index]
  }

  async validateRawTx(rawTx: Uint8Array): Promise<unknown> {
    this.validateCalls.push(rawTx)
    return this.validateImpl(rawTx)
  }

  async tx(txid: string): Promise<unknown> {
    this.txCalls.push(txid)
    return this.txImpl(txid)
  }
}

const signedBytesFor = (
  candidate: CommunityParentExecutionCandidate,
  mutate?: (tx: Tx) => void
): Uint8Array => {
  const tx = Tx.fromHex(candidate.unsignedTxHex)
  tx.inputs.forEach((input, index) => {
    input.script = new Script(Uint8Array.of(1, index + 1))
  })
  mutate?.(tx)
  return tx.ser()
}

const chronikTxFor = (
  candidate: CommunityParentExecutionCandidate,
  rawTx: Uint8Array
): unknown => {
  const tx = Tx.deser(rawTx)
  const txid = tx.txid()
  return {
    txid,
    tokenStatus: 'TOKEN_STATUS_NORMAL',
    tokenFailedParsings: [],
    inputs: candidate.plan.selectedInputs.map((input) => ({
      prevOut: input.outpoint,
      sats: input.sats,
      outputScript: input.outputScript
    })),
    outputs: candidate.plan.outputs.map((output, index) => ({
      sats: output.sats,
      outputScript: output.scriptHex,
      ...(index === 1
        ? {
            token: {
              tokenId: txid,
              tokenType: { protocol: 'SLP', number: 129 },
              atoms: 1n,
              isMintBaton: false
            }
          }
        : index === 2
          ? {
              token: {
                tokenId: txid,
                tokenType: { protocol: 'SLP', number: 129 },
                atoms: 0n,
                isMintBaton: true
              }
            }
          : {})
    })),
    tokenEntries: [
      {
        tokenId: txid,
        tokenType: { protocol: 'SLP', number: 129 },
        txType: 'GENESIS',
        isInvalid: false,
        actualBurnAtoms: 0n,
        burnsMintBatons: false
      }
    ]
  }
}

const authorizationFor = (fingerprint: string) => ({
  BROADCAST: '1',
  CONFIRM_COMMUNITY_PARENT_GENESIS: 'YES',
  CONFIRM_PLAN_SHA256: fingerprint
})

describe('canonical live planning and fingerprint', () => {
  it.each(['mainnet', 'testnet', 'regtest'] as const)(
    'supports explicit %s with four independent destinations',
    async (network) => {
      const config = configFor(network)
      const expectedScript = toHex(Address.parse(config.fundingAddress).toScript().bytecode)
      const candidate = await prepareCommunityParentExecution({
        config,
        reader: new MockReader(liveResponse([liveUtxo()], expectedScript))
      })
      expect(candidate.plan.network).toBe(network)
      expect(new Set([
        candidate.plan.fundingAddress,
        candidate.plan.tokenDestinationAddress,
        candidate.plan.batonDestinationAddress,
        candidate.plan.changeAddress
      ]).size).toBe(4)
      expect(candidate.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    }
  )

  it('rejects an invalid runtime network before producing a candidate', async () => {
    await expect(prepareCommunityParentExecution({
      config: { ...configFor(), network: 'staging' as CommunityParentNetwork },
      reader: new MockReader()
    })).rejects.toThrow(/Network/)
  })

  it('rejects an empty or control-character endpoint label', async () => {
    for (const endpointLabel of ['', 'https://chronik.e.cash\nspoofed']) {
      const reader = new MockReader() as MockReader & { endpointLabel: string }
      Object.defineProperty(reader, 'endpointLabel', { value: endpointLabel })
      await expect(prepareCommunityParentExecution({ config: configFor(), reader })).rejects.toThrow(
        /endpoint label/
      )
    }
  })

  it('constructs a full unsigned tx and recommits every canonical invariant', async () => {
    const candidate = await prepareCommunityParentExecution({
      config: configFor(),
      reader: new MockReader()
    })
    const unsigned = Tx.fromHex(candidate.unsignedTxHex)
    expect(unsigned.inputs).toHaveLength(candidate.plan.selectedInputs.length)
    expect(unsigned.outputs).toHaveLength(candidate.plan.outputs.length)
    expect(unsigned.inputs.every((input) => (input.script?.bytecode.length ?? 0) === 0)).toBe(true)
    expect(candidate.plan).toMatchObject({
      tokenType: COMMUNITY_PARENT_TOKEN_TYPE,
      tokenName: COMMUNITY_PARENT_TOKEN_NAME,
      tokenTicker: COMMUNITY_PARENT_TOKEN_TICKER,
      decimals: 0,
      initialQuantity: COMMUNITY_PARENT_INITIAL_QUANTITY,
      mintBatonVout: COMMUNITY_PARENT_MINT_BATON_VOUT,
      documentHash: COMMUNITY_PARENT_DOCUMENT_HASH
    })
    expect(candidate.plan.outputs.map((output) => output.vout)).toEqual([0, 1, 2, 3])
    expect(candidate.plan.estimatedFeeSats).toBeLessThanOrEqual(candidate.maximumFeeSats)
  })

  it('is deterministic and changes the fingerprint when live funding changes', async () => {
    const first = await prepareCommunityParentExecution({ config: configFor(), reader: new MockReader() })
    const same = await prepareCommunityParentExecution({ config: configFor(), reader: new MockReader() })
    const changed = await prepareCommunityParentExecution({
      config: configFor(),
      reader: new MockReader(liveResponse([liveUtxo({ sats: 11_000n })]))
    })
    expect(same.fingerprint).toBe(first.fingerprint)
    expect(changed.fingerprint).not.toBe(first.fingerprint)
  })

  it('formats the exact dry-run security preview without secret material', async () => {
    const candidate = await prepareCommunityParentExecution({ config: configFor(), reader: new MockReader() })
    const preview = formatCommunityParentExecutionPreview(candidate)
    expect(preview).toContain('MODE: DRY_RUN')
    expect(preview).toContain(`NETWORK: mainnet`)
    expect(preview).toContain(`PLAN FINGERPRINT: ${candidate.fingerprint}`)
    expect(preview).toContain('NO SIGNING PERFORMED')
    expect(preview).toContain('NO BROADCAST PERFORMED')
    expect(preview).not.toMatch(/WIF|mnemonic|privateKey|seed/i)
  })
})

describe('live pure-XEC revalidation', () => {
  it.each([
    { tokenType: { protocol: 'SLP', number: 1 }, atoms: 1n, isMintBaton: false },
    { tokenType: { protocol: 'SLP', number: 65 }, atoms: 1n, isMintBaton: false },
    { tokenType: { protocol: 'SLP', number: 129 }, atoms: 1n, isMintBaton: false },
    { tokenType: { protocol: 'SLP', number: 129 }, atoms: 0n, isMintBaton: true },
    { tokenType: { protocol: 'ALP', number: 0 }, atoms: 1n, isMintBaton: false }
  ])('never selects token-bearing funding: $tokenType.protocol/$tokenType.number', async (token) => {
    const sign = vi.fn()
    const broadcast = vi.fn()
    await expect(executeCommunityParentGenesis({
      config: configFor(),
      reader: new MockReader(liveResponse([liveUtxo({ token })])),
      gates: {},
      signer: { sign },
      broadcaster: { broadcast }
    })).rejects.toThrow()
    expect(sign).toHaveBeenCalledTimes(0)
    expect(broadcast).toHaveBeenCalledTimes(0)
  })

  it.each([
    ['wrong address', liveResponse([liveUtxo()], toHex(Address.parse(TOKEN_ADDRESS).toScript().bytecode))],
    ['duplicate', liveResponse([liveUtxo(), liveUtxo()])],
    ['coinbase', liveResponse([liveUtxo({ isCoinbase: true })])],
    ['malformed', { outputScript: FUNDING_SCRIPT, utxos: [null] }],
    ['null token annotation', liveResponse([liveUtxo({ token: null })])]
  ])('fails closed on %s', async (_label, response) => {
    await expect(prepareCommunityParentExecution({
      config: configFor(),
      reader: new MockReader(response)
    })).rejects.toThrow()
  })

  it('fails closed on Chronik transport errors', async () => {
    const reader = new MockReader()
    reader.addressUtxos = vi.fn(async () => {
      throw new Error('timeout')
    })
    await expect(prepareCommunityParentExecution({ config: configFor(), reader })).rejects.toThrow(
      /failed closed/
    )
  })

  it.each([
    ['wrong address', new MockReader(liveResponse([liveUtxo()], toHex(Address.parse(TOKEN_ADDRESS).toScript().bytecode)))],
    ['duplicate UTXO', new MockReader(liveResponse([liveUtxo(), liveUtxo()]))]
  ])('keeps signing and broadcast at zero for %s', async (_label, reader) => {
    const sign = vi.fn()
    const broadcast = vi.fn()
    await expect(executeCommunityParentGenesis({
      config: configFor(),
      reader,
      gates: {},
      signer: { sign },
      broadcaster: { broadcast }
    })).rejects.toThrow()
    expect(sign).toHaveBeenCalledTimes(0)
    expect(broadcast).toHaveBeenCalledTimes(0)
  })

  it('keeps signing and broadcast at zero for a Chronik exception', async () => {
    const reader = new MockReader()
    reader.addressUtxos = vi.fn(async () => { throw new Error('transport') })
    const sign = vi.fn()
    const broadcast = vi.fn()
    await expect(executeCommunityParentGenesis({
      config: configFor(),
      reader,
      gates: {},
      signer: { sign },
      broadcaster: { broadcast }
    })).rejects.toThrow(/failed closed/)
    expect(sign).toHaveBeenCalledTimes(0)
    expect(broadcast).toHaveBeenCalledTimes(0)
  })
})

describe('three execution gates and immediate re-plan', () => {
  it('defaults to dry-run with exactly zero signing and broadcast calls', async () => {
    const sign = vi.fn()
    const broadcast = vi.fn()
    const reader = new MockReader()
    const result = await executeCommunityParentGenesis({
      config: configFor(),
      reader,
      gates: {},
      signer: { sign },
      broadcaster: { broadcast }
    })
    expect(result.status).toBe('dry-run')
    expect(sign).toHaveBeenCalledTimes(0)
    expect(broadcast).toHaveBeenCalledTimes(0)
    expect(reader.addressCalls).toHaveLength(1)
  })

  it.each([
    { BROADCAST: '1' },
    { CONFIRM_COMMUNITY_PARENT_GENESIS: 'YES' },
    { CONFIRM_PLAN_SHA256: '00'.repeat(32) },
    { BROADCAST: '1', CONFIRM_COMMUNITY_PARENT_GENESIS: 'YES' },
    {
      BROADCAST: '1',
      CONFIRM_COMMUNITY_PARENT_GENESIS: 'YES',
      CONFIRM_PLAN_SHA256: '00'.repeat(32)
    }
  ])('rejects incomplete or mismatched gates: %o', async (gates) => {
    const sign = vi.fn()
    const broadcast = vi.fn()
    await expect(executeCommunityParentGenesis({
      config: configFor(),
      reader: new MockReader(),
      gates,
      signer: { sign },
      broadcaster: { broadcast }
    })).rejects.toThrow(/authorization|fingerprint/)
    expect(sign).toHaveBeenCalledTimes(0)
    expect(broadcast).toHaveBeenCalledTimes(0)
  })

  it.each([
    ['UTXO disappeared', liveResponse([])],
    ['amount changed', liveResponse([liveUtxo({ sats: 9_999n })])],
    ['token annotation appeared', liveResponse([liveUtxo({ token: {
      tokenType: { protocol: 'SLP', number: 1 }, atoms: 1n, isMintBaton: false
    } })])]
  ])('does not sign when %s after preview', async (_label, changedResponse) => {
    const preview = await prepareCommunityParentExecution({ config: configFor(), reader: new MockReader() })
    const sign = vi.fn()
    const broadcast = vi.fn()
    await expect(executeCommunityParentGenesis({
      config: configFor(),
      reader: new MockReader(liveResponse(), changedResponse),
      gates: authorizationFor(preview.fingerprint),
      signer: { sign },
      broadcaster: { broadcast }
    })).rejects.toThrow()
    expect(sign).toHaveBeenCalledTimes(0)
    expect(broadcast).toHaveBeenCalledTimes(0)
  })
})

describe('signing, signed-tx verification, and broadcast', () => {
  it('calls the mock signer and broadcaster exactly once only after all checks', async () => {
    const preview = await prepareCommunityParentExecution({ config: configFor(), reader: new MockReader() })
    const reader = new MockReader(liveResponse(), liveResponse())
    let executionCandidate: CommunityParentExecutionCandidate | undefined
    const sign = vi.fn(async (candidate: CommunityParentExecutionCandidate) => {
      executionCandidate = candidate
      return signedBytesFor(candidate)
    })
    reader.validateImpl = async (rawTx) => chronikTxFor(executionCandidate!, rawTx)
    reader.txImpl = async () => chronikTxFor(executionCandidate!, signedBytesFor(executionCandidate!))
    const broadcast = vi.fn(async (rawTx: Uint8Array) => ({ txid: Tx.deser(rawTx).txid() }))
    const order: string[] = []
    broadcast.mockImplementationOnce(async (rawTx: Uint8Array) => {
      order.push('broadcast')
      return { txid: Tx.deser(rawTx).txid() }
    })
    const result = await executeCommunityParentGenesis({
      config: configFor(),
      reader,
      gates: authorizationFor(preview.fingerprint),
      signer: { sign },
      broadcaster: { broadcast },
      onSignedTxCandidate: () => order.push('txid-preview')
    })
    expect(result.status).toBe('broadcast-confirmed')
    expect(sign).toHaveBeenCalledTimes(1)
    expect(reader.addressCalls).toHaveLength(2)
    expect(reader.validateCalls).toHaveLength(1)
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(reader.txCalls).toHaveLength(1)
    expect(order).toEqual(['txid-preview', 'broadcast'])
  })

  it.each([
    ['baton output changed', (tx: Tx) => { tx.outputs[2]!.script = new Script(Uint8Array.of(0x51)) }],
    ['change destination changed', (tx: Tx) => { tx.outputs[3]!.script = new Script(Uint8Array.of(0x51)) }],
    ['OP_RETURN changed', (tx: Tx) => { tx.outputs[0]!.script = new Script(Uint8Array.of(0x6a)) }],
    ['fee changed', (tx: Tx) => { tx.outputs[3]!.sats -= 1n }],
    ['input changed', (tx: Tx) => { tx.inputs[0]!.prevOut.outIdx += 1 }]
  ])('rejects a hostile signer when %s', async (_label, mutate) => {
    const preview = await prepareCommunityParentExecution({ config: configFor(), reader: new MockReader() })
    const broadcast = vi.fn()
    await expect(executeCommunityParentGenesis({
      config: configFor(),
      reader: new MockReader(liveResponse(), liveResponse()),
      gates: authorizationFor(preview.fingerprint),
      signer: { sign: async (candidate) => signedBytesFor(candidate, mutate) },
      broadcaster: { broadcast }
    })).rejects.toThrow(/Signed transaction/)
    expect(broadcast).toHaveBeenCalledTimes(0)
  })

  it('fails closed when Chronik pre-broadcast validation rejects the signed tx', async () => {
    const preview = await prepareCommunityParentExecution({ config: configFor(), reader: new MockReader() })
    const reader = new MockReader(liveResponse(), liveResponse())
    reader.validateImpl = async () => { throw new Error('rejected') }
    const broadcast = vi.fn()
    await expect(executeCommunityParentGenesis({
      config: configFor(),
      reader,
      gates: authorizationFor(preview.fingerprint),
      signer: { sign: async (candidate) => signedBytesFor(candidate) },
      broadcaster: { broadcast }
    })).rejects.toThrow(/pre-broadcast/)
    expect(broadcast).toHaveBeenCalledTimes(0)
  })

  it('does not broadcast when Chronik marks the signed token transaction invalid', async () => {
    const preview = await prepareCommunityParentExecution({ config: configFor(), reader: new MockReader() })
    const reader = new MockReader(liveResponse(), liveResponse())
    let candidate: CommunityParentExecutionCandidate | undefined
    reader.validateImpl = async (rawTx) => ({
      ...(chronikTxFor(candidate!, rawTx) as Record<string, unknown>),
      tokenStatus: 'TOKEN_STATUS_NOT_NORMAL'
    })
    const broadcast = vi.fn()
    await expect(executeCommunityParentGenesis({
      config: configFor(),
      reader,
      gates: authorizationFor(preview.fingerprint),
      signer: { sign: async (value) => {
        candidate = value
        return signedBytesFor(value)
      } },
      broadcaster: { broadcast }
    })).rejects.toThrow(/failed closed/)
    expect(broadcast).toHaveBeenCalledTimes(0)
  })

  it('reports one ambiguous broadcast attempt and never retries', async () => {
    const preview = await prepareCommunityParentExecution({ config: configFor(), reader: new MockReader() })
    const reader = new MockReader(liveResponse(), liveResponse())
    let candidate: CommunityParentExecutionCandidate | undefined
    reader.validateImpl = async (rawTx) => chronikTxFor(candidate!, rawTx)
    const broadcast = vi.fn(async () => { throw new Error('timeout after submit') })
    const result = await executeCommunityParentGenesis({
      config: configFor(),
      reader,
      gates: authorizationFor(preview.fingerprint),
      signer: { sign: async (value) => {
        candidate = value
        return signedBytesFor(value)
      } },
      broadcaster: { broadcast }
    })
    expect(result.status).toBe('broadcast-status-ambiguous')
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(reader.txCalls).toHaveLength(0)
  })

  it('reports accepted/pending without inventing post-broadcast confirmation', async () => {
    const preview = await prepareCommunityParentExecution({ config: configFor(), reader: new MockReader() })
    const reader = new MockReader(liveResponse(), liveResponse())
    let candidate: CommunityParentExecutionCandidate | undefined
    reader.validateImpl = async (rawTx) => chronikTxFor(candidate!, rawTx)
    reader.txImpl = async () => { throw new Error('not indexed yet') }
    const broadcast = vi.fn(async (rawTx: Uint8Array) => ({ txid: Tx.deser(rawTx).txid() }))
    const result = await executeCommunityParentGenesis({
      config: configFor(),
      reader,
      gates: authorizationFor(preview.fingerprint),
      signer: { sign: async (value) => {
        candidate = value
        return signedBytesFor(value)
      } },
      broadcaster: { broadcast }
    })
    expect(result.status).toBe('broadcast-accepted-chain-verification-pending')
    expect(broadcast).toHaveBeenCalledTimes(1)
  })
})

describe('scope, API, and secret boundaries', () => {
  it('obtains the plan from the canonical planner and exposes no arbitrary-plan executor API', () => {
    const source = readFileSync(new URL('./communityParentExecutor.ts', import.meta.url), 'utf8')
    expect(source).toContain('buildCommunityParentGenesisPlan({ config: params.config, fundingUtxos })')
    expect(source).not.toMatch(/executeCommunityParentGenesis\s*=.*arbitraryPlan/s)
    expect(source).not.toMatch(/NFT_COLLECTIONS|classifyCollection|nftEvidenceExtractor/)
  })

  it('uses a dedicated lazy secret environment source and accepts no CLI arguments', () => {
    const cli = readFileSync(new URL('../../scripts/broadcast-community-parent.ts', import.meta.url), 'utf8')
    expect(cli).toContain("const SIGNING_SECRET_ENV = 'COMMUNITY_PARENT_SIGNING_SECRET_HEX'")
    expect(cli).toContain('process.argv.slice(2)')
    expect(cli).toContain('secret.fill(0)')
    expect(cli).not.toMatch(/--wif|--private-key|--mnemonic/i)
    expect(cli).not.toMatch(/console\.log\([^\n]*(secret|private|mnemonic|seed)/i)
  })

  it('does not modify or import trust policy, metadata upload, UI, or NFT Child paths', () => {
    const source = readFileSync(new URL('./communityParentExecutor.ts', import.meta.url), 'utf8')
    const cli = readFileSync(new URL('../../scripts/broadcast-community-parent.ts', import.meta.url), 'utf8')
    expect(`${source}\n${cli}`).not.toMatch(/NFT_COLLECTIONS|community\.parentTokenId|Pinata|Agora|React/)
    expect(`${source}\n${cli}`).not.toMatch(/slpMint|SLP_NFT1_CHILD|NFT_MINT_PLATFORM_FEE/)
  })
})
