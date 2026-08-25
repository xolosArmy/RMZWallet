import { readFileSync } from 'node:fs'
import {
  ALL_BIP143,
  Address,
  Ecc,
  P2PKHSignatory,
  Script,
  Tx,
  TxBuilder,
  fromHex,
  pushBytesOp,
  shaRmd160,
  toHex
} from 'ecash-lib'
import { describe, expect, it, vi } from 'vitest'
import {
  COMMUNITY_PARENT_DOCUMENT_HASH,
  COMMUNITY_PARENT_DUST_SATS,
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
  COMMUNITY_PARENT_EXECUTION_FEE_PER_KB,
  ECASH_MAINNET_EXECUTION_CHECKPOINT,
  classifyChronikClientV3BroadcastFailure,
  executeCommunityParentGenesis,
  formatCommunityParentExecutionPreview,
  prepareCommunityParentExecution
} from './communityParentExecutor'
import type {
  CommunityParentChronikReader,
  CommunityParentExecutionCandidate,
  CommunityParentSigner
} from './communityParentExecutor'

/** Public deterministic key 1 fixture. Never use it for funds. */
const FIXTURE_SECRET = Uint8Array.from([...new Uint8Array(31), 1])
const FIXTURE_PUBLIC_KEY = new Ecc().derivePubkey(FIXTURE_SECRET)
const FIXTURE_PUBLIC_KEY_HEX = toHex(FIXTURE_PUBLIC_KEY)
const FUNDING_ADDRESS = 'ecash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cacy2kzvq'
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

const fundingTxFor = (utxo: LiveUtxo, outputScript = FUNDING_SCRIPT): unknown => {
  const outputs = Array.from({ length: utxo.outpoint.outIdx + 1 }, () => ({
    sats: 1n,
    outputScript: toHex(Address.parse(TOKEN_ADDRESS).toScript().bytecode)
  }))
  outputs[utxo.outpoint.outIdx] = { sats: utxo.sats, outputScript }
  return { txid: utxo.outpoint.txid, outputs }
}

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
  readonly blockCalls: number[] = []
  readonly addressCalls: string[] = []
  readonly validateCalls: Uint8Array[] = []
  readonly txCalls: string[] = []
  private readonly responses: unknown[]
  blockImpl: (height: number) => Promise<unknown> = async (height) => ({
    blockInfo: { height, hash: ECASH_MAINNET_EXECUTION_CHECKPOINT.hash }
  })
  validateImpl: (rawTx: Uint8Array) => Promise<unknown> = async () => {
    throw new Error('validateRawTx mock not configured')
  }
  txImpl: (txid: string) => Promise<unknown> = async (txid) =>
    fundingTxFor(liveUtxo({ outpoint: { txid, outIdx: 0 } }))

  constructor(...responses: unknown[]) {
    this.responses = responses.length === 0 ? [liveResponse()] : responses
  }

  async block(height: number): Promise<unknown> {
    this.blockCalls.push(height)
    return this.blockImpl(height)
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
  mutate?: (tx: Tx) => void,
  inputSats?: (sats: bigint, index: number) => bigint
): Uint8Array => {
  const signatory = P2PKHSignatory(FIXTURE_SECRET, FIXTURE_PUBLIC_KEY, ALL_BIP143)
  const tx = new TxBuilder({
    inputs: candidate.plan.selectedInputs.map((input, index) => ({
      input: {
        prevOut: input.outpoint,
        signData: {
          sats: inputSats?.(input.sats, index) ?? input.sats,
          outputScript: new Script(fromHex(input.outputScript))
        }
      },
      signatory
    })),
    outputs: candidate.plan.outputs.map((output) => ({
      sats: output.sats,
      script: new Script(fromHex(output.scriptHex))
    }))
  }).sign({
    feePerKb: COMMUNITY_PARENT_EXECUTION_FEE_PER_KB,
    dustSats: COMMUNITY_PARENT_DUST_SATS
  })
  mutate?.(tx)
  return tx.ser()
}

const signerWith = (
  sign: CommunityParentSigner['sign'],
  publicKeyHex = FIXTURE_PUBLIC_KEY_HEX
): CommunityParentSigner => ({ publicKeyHex, sign })

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

describe('mainnet identity and signing-authority binding', () => {
  it.each(['testnet', 'regtest'] as const)(
    'rejects operational execution on %s before any Chronik, signing, or broadcast call',
    async (network) => {
      const reader = new MockReader()
      const sign = vi.fn()
      const broadcast = vi.fn()
      await expect(executeCommunityParentGenesis({
        config: configFor(network),
        reader,
        gates: {},
        signer: signerWith(sign),
        broadcaster: { broadcast }
      })).rejects.toThrow(/restricted to mainnet/)
      expect(reader.blockCalls).toHaveLength(0)
      expect(reader.addressCalls).toHaveLength(0)
      expect(sign).toHaveBeenCalledTimes(0)
      expect(broadcast).toHaveBeenCalledTimes(0)
    }
  )

  it('rejects a wrong configured key before the first Chronik call', async () => {
    const preview = await prepareCommunityParentExecution({ config: configFor(), reader: new MockReader() })
    const wrongSecret = Uint8Array.from([...new Uint8Array(31), 2])
    const wrongPublicKeyHex = toHex(new Ecc().derivePubkey(wrongSecret))
    const reader = new MockReader()
    const sign = vi.fn()
    const broadcast = vi.fn()
    await expect(executeCommunityParentGenesis({
      config: configFor(),
      reader,
      gates: authorizationFor(preview.fingerprint),
      signer: signerWith(sign, wrongPublicKeyHex),
      broadcaster: { broadcast }
    })).rejects.toThrow(/does not control the funding address/)
    expect(reader.blockCalls).toHaveLength(0)
    expect(reader.addressCalls).toHaveLength(0)
    expect(sign).toHaveBeenCalledTimes(0)
    expect(broadcast).toHaveBeenCalledTimes(0)
  })

  it('rejects a funding address not controlled by the configured key before Chronik', async () => {
    const reader = new MockReader()
    const sign = vi.fn()
    const broadcast = vi.fn()
    await expect(executeCommunityParentGenesis({
      config: configFor('mainnet', { fundingAddress: TOKEN_ADDRESS }),
      reader,
      gates: { BROADCAST: '1' },
      signer: signerWith(sign),
      broadcaster: { broadcast }
    })).rejects.toThrow(/does not control the funding address/)
    expect(reader.blockCalls).toHaveLength(0)
    expect(reader.addressCalls).toHaveLength(0)
    expect(sign).toHaveBeenCalledTimes(0)
    expect(broadcast).toHaveBeenCalledTimes(0)
  })

  it.each(['', '04'.concat('11'.repeat(64)), '02'.concat('zz'.repeat(32))])(
    'rejects malformed signer public key %j before Chronik',
    async (publicKeyHex) => {
      const reader = new MockReader()
      const sign = vi.fn()
      const broadcast = vi.fn()
      await expect(executeCommunityParentGenesis({
        config: configFor(),
        reader,
        gates: { BROADCAST: '1' },
        signer: signerWith(sign, publicKeyHex),
        broadcaster: { broadcast }
      })).rejects.toThrow(/public key/)
      expect(reader.blockCalls).toHaveLength(0)
      expect(reader.addressCalls).toHaveLength(0)
      expect(sign).toHaveBeenCalledTimes(0)
      expect(broadcast).toHaveBeenCalledTimes(0)
    }
  )

  it.each([
    ['wrong hash', { blockInfo: { height: 949_200, hash: '00'.repeat(32) } }],
    ['wrong height', { blockInfo: { height: 949_199, hash: ECASH_MAINNET_EXECUTION_CHECKPOINT.hash } }],
    ['malformed response', { hash: ECASH_MAINNET_EXECUTION_CHECKPOINT.hash }],
    ['hostile null', null]
  ])('fails closed on a %s checkpoint response before UTXO reads', async (_label, response) => {
    const reader = new MockReader()
    reader.blockImpl = vi.fn(async () => response)
    const sign = vi.fn()
    const broadcast = vi.fn()
    await expect(executeCommunityParentGenesis({
      config: configFor(),
      reader,
      gates: {},
      signer: signerWith(sign),
      broadcaster: { broadcast }
    })).rejects.toThrow(/checkpoint verification failed closed/)
    expect(reader.addressCalls).toHaveLength(0)
    expect(sign).toHaveBeenCalledTimes(0)
    expect(broadcast).toHaveBeenCalledTimes(0)
  })

  it('fails closed on checkpoint transport failure before UTXO reads', async () => {
    const reader = new MockReader()
    reader.blockImpl = vi.fn(async () => { throw new Error('timeout') })
    const sign = vi.fn()
    const broadcast = vi.fn()
    await expect(executeCommunityParentGenesis({
      config: configFor(),
      reader,
      gates: {},
      signer: signerWith(sign),
      broadcaster: { broadcast }
    })).rejects.toThrow(/checkpoint verification failed closed/)
    expect(reader.addressCalls).toHaveLength(0)
    expect(sign).toHaveBeenCalledTimes(0)
    expect(broadcast).toHaveBeenCalledTimes(0)
  })

  it('revalidates the immutable checkpoint immediately before fresh planning', async () => {
    const preview = await prepareCommunityParentExecution({ config: configFor(), reader: new MockReader() })
    const reader = new MockReader()
    reader.blockImpl = vi.fn(async () =>
      reader.blockCalls.length === 1
        ? { blockInfo: ECASH_MAINNET_EXECUTION_CHECKPOINT }
        : { blockInfo: { ...ECASH_MAINNET_EXECUTION_CHECKPOINT, hash: '00'.repeat(32) } }
    )
    const sign = vi.fn()
    const broadcast = vi.fn()
    await expect(executeCommunityParentGenesis({
      config: configFor(),
      reader,
      gates: authorizationFor(preview.fingerprint),
      signer: signerWith(sign),
      broadcaster: { broadcast }
    })).rejects.toThrow(/checkpoint verification failed closed/)
    expect(reader.blockCalls).toHaveLength(2)
    expect(reader.addressCalls).toHaveLength(1)
    expect(sign).toHaveBeenCalledTimes(0)
    expect(broadcast).toHaveBeenCalledTimes(0)
  })

  it('revalidates every selected prevout against the signing key before sign()', async () => {
    const first = liveUtxo({
      outpoint: { txid: '11'.repeat(32), outIdx: 0 },
      sats: 900n
    })
    const second = liveUtxo({
      outpoint: { txid: '22'.repeat(32), outIdx: 0 },
      sats: 900n
    })
    const response = liveResponse([first, second])
    const preview = await prepareCommunityParentExecution({
      config: configFor(),
      reader: new MockReader(response)
    })
    expect(preview.plan.selectedInputs).toHaveLength(2)
    const reader = new MockReader(response, response)
    reader.txImpl = async (txid) =>
      txid === first.outpoint.txid
        ? fundingTxFor(first)
        : fundingTxFor(second, toHex(Address.parse(TOKEN_ADDRESS).toScript().bytecode))
    const sign = vi.fn()
    const broadcast = vi.fn()
    await expect(executeCommunityParentGenesis({
      config: configFor(),
      reader,
      gates: authorizationFor(preview.fingerprint),
      signer: signerWith(sign),
      broadcaster: { broadcast }
    })).rejects.toThrow(/ownership revalidation failed closed/)
    expect(reader.txCalls).toEqual([first.outpoint.txid, second.outpoint.txid])
    expect(sign).toHaveBeenCalledTimes(0)
    expect(broadcast).toHaveBeenCalledTimes(0)
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
      signer: signerWith(sign),
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
      signer: signerWith(sign),
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
      signer: signerWith(sign),
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
      signer: signerWith(sign),
      broadcaster: { broadcast }
    })
    expect(result.status).toBe('dry-run')
    expect(sign).toHaveBeenCalledTimes(0)
    expect(broadcast).toHaveBeenCalledTimes(0)
    expect(reader.blockCalls).toEqual([ECASH_MAINNET_EXECUTION_CHECKPOINT.height])
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
      signer: signerWith(sign),
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
      signer: signerWith(sign),
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
    reader.txImpl = async (txid) =>
      txid === liveUtxo().outpoint.txid
        ? fundingTxFor(liveUtxo())
        : chronikTxFor(executionCandidate!, signedBytesFor(executionCandidate!))
    const broadcast = vi.fn(async (rawTx: Uint8Array) => ({
      status: 'accepted' as const,
      txid: Tx.deser(rawTx).txid()
    }))
    const order: string[] = []
    broadcast.mockImplementationOnce(async (rawTx: Uint8Array) => {
      order.push('broadcast')
      return { status: 'accepted' as const, txid: Tx.deser(rawTx).txid() }
    })
    const result = await executeCommunityParentGenesis({
      config: configFor(),
      reader,
      gates: authorizationFor(preview.fingerprint),
      signer: signerWith(sign),
      broadcaster: { broadcast },
      onSignedTxCandidate: () => order.push('txid-preview')
    })
    expect(result.status).toBe('broadcast-confirmed')
    expect(sign).toHaveBeenCalledTimes(1)
    expect(reader.blockCalls).toEqual([
      ECASH_MAINNET_EXECUTION_CHECKPOINT.height,
      ECASH_MAINNET_EXECUTION_CHECKPOINT.height
    ])
    expect(reader.addressCalls).toHaveLength(2)
    expect(reader.validateCalls).toHaveLength(1)
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(reader.txCalls).toHaveLength(2)
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
      signer: signerWith(async (candidate) => signedBytesFor(candidate, mutate)),
      broadcaster: { broadcast }
    })).rejects.toThrow(/Signed transaction/)
    expect(broadcast).toHaveBeenCalledTimes(0)
  })

  it.each([
    ['empty scriptSig', (tx: Tx) => { tx.inputs[0]!.script = new Script() }],
    ['malformed push encoding', (tx: Tx) => { tx.inputs[0]!.script = new Script(Uint8Array.of(0x4c)) }],
    ['wrong sighash byte', (tx: Tx) => {
      const bytes = tx.inputs[0]!.script!.bytecode.slice()
      bytes[65] = 0x01
      tx.inputs[0]!.script = new Script(bytes)
    }],
    ['corrupted Schnorr signature', (tx: Tx) => {
      const bytes = tx.inputs[0]!.script!.bytecode.slice()
      bytes[1] ^= 0x01
      tx.inputs[0]!.script = new Script(bytes)
    }],
    ['wrong pushed public key', (tx: Tx) => {
      const wrongSecret = Uint8Array.from([...new Uint8Array(31), 2])
      const wrongPublicKey = new Ecc().derivePubkey(wrongSecret)
      expect(toHex(Script.p2pkh(shaRmd160(wrongPublicKey)).bytecode)).not.toBe(FUNDING_SCRIPT)
      const signature = tx.inputs[0]!.script!.bytecode.slice(1, 66)
      tx.inputs[0]!.script = Script.fromOps([
        pushBytesOp(signature),
        pushBytesOp(wrongPublicKey)
      ])
    }]
  ])('rejects a signer result with %s before broadcast', async (_label, mutate) => {
    const preview = await prepareCommunityParentExecution({ config: configFor(), reader: new MockReader() })
    const broadcast = vi.fn()
    await expect(executeCommunityParentGenesis({
      config: configFor(),
      reader: new MockReader(liveResponse(), liveResponse()),
      gates: authorizationFor(preview.fingerprint),
      signer: signerWith(async (candidate) => signedBytesFor(candidate, mutate)),
      broadcaster: { broadcast }
    })).rejects.toThrow(/Signed transaction/)
    expect(broadcast).toHaveBeenCalledTimes(0)
  })

  it('rejects a valid-looking signature made with the wrong input amount', async () => {
    const preview = await prepareCommunityParentExecution({ config: configFor(), reader: new MockReader() })
    const broadcast = vi.fn()
    await expect(executeCommunityParentGenesis({
      config: configFor(),
      reader: new MockReader(liveResponse(), liveResponse()),
      gates: authorizationFor(preview.fingerprint),
      signer: signerWith(async (candidate) =>
        signedBytesFor(candidate, undefined, (sats) => sats + 1n)
      ),
      broadcaster: { broadcast }
    })).rejects.toThrow(/invalid Schnorr signature/)
    expect(broadcast).toHaveBeenCalledTimes(0)
  })

  it('rejects a signature copied from another input and one invalid input among many', async () => {
    const first = liveUtxo({ outpoint: { txid: '11'.repeat(32), outIdx: 0 }, sats: 900n })
    const second = liveUtxo({ outpoint: { txid: '22'.repeat(32), outIdx: 0 }, sats: 900n })
    const response = liveResponse([first, second])
    const preview = await prepareCommunityParentExecution({
      config: configFor(),
      reader: new MockReader(response)
    })
    const reader = new MockReader(response, response)
    reader.txImpl = async (txid) =>
      fundingTxFor(txid === first.outpoint.txid ? first : second)
    const broadcast = vi.fn()
    await expect(executeCommunityParentGenesis({
      config: configFor(),
      reader,
      gates: authorizationFor(preview.fingerprint),
      signer: signerWith(async (candidate) => signedBytesFor(candidate, (tx) => {
        tx.inputs[1]!.script = tx.inputs[0]!.script!.copy()
      })),
      broadcaster: { broadcast }
    })).rejects.toThrow(/invalid Schnorr signature/)
    expect(broadcast).toHaveBeenCalledTimes(0)
  })

  it('accepts only canonical two-push 0x41 Schnorr P2PKH scriptSigs', async () => {
    const preview = await prepareCommunityParentExecution({ config: configFor(), reader: new MockReader() })
    const reader = new MockReader(liveResponse(), liveResponse())
    let candidate: CommunityParentExecutionCandidate | undefined
    reader.validateImpl = async (rawTx) => chronikTxFor(candidate!, rawTx)
    reader.txImpl = async (txid) =>
      txid === liveUtxo().outpoint.txid
        ? fundingTxFor(liveUtxo())
        : chronikTxFor(candidate!, signedBytesFor(candidate!))
    const broadcast = vi.fn(async (rawTx: Uint8Array) => ({
      status: 'accepted' as const,
      txid: Tx.deser(rawTx).txid()
    }))
    const result = await executeCommunityParentGenesis({
      config: configFor(),
      reader,
      gates: authorizationFor(preview.fingerprint),
      signer: signerWith(async (value) => {
        candidate = value
        const bytes = signedBytesFor(value)
        const script = Tx.deser(bytes).inputs[0]!.script!.bytecode
        expect(script).toHaveLength(100)
        expect(script[0]).toBe(65)
        expect(script[65]).toBe(0x41)
        expect(script[66]).toBe(33)
        return bytes
      }),
      broadcaster: { broadcast }
    })
    expect(result.status).toBe('broadcast-confirmed')
    expect(broadcast).toHaveBeenCalledTimes(1)
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
      signer: signerWith(async (candidate) => signedBytesFor(candidate)),
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
      signer: signerWith(async (value) => {
        candidate = value
        return signedBytesFor(value)
      }),
      broadcaster: { broadcast }
    })).rejects.toThrow(/failed closed/)
    expect(broadcast).toHaveBeenCalledTimes(0)
  })

  it.each([
    ['timeout', new Error('timeout after submit')],
    ['connection reset', Object.assign(new Error('reset after submit'), { code: 'ECONNRESET' })],
    ['unknown thrown value', { unexpected: true }]
  ])('reports one ambiguous broadcast attempt for %s and never retries', async (_label, failure) => {
    const preview = await prepareCommunityParentExecution({ config: configFor(), reader: new MockReader() })
    const reader = new MockReader(liveResponse(), liveResponse())
    let candidate: CommunityParentExecutionCandidate | undefined
    reader.validateImpl = async (rawTx) => chronikTxFor(candidate!, rawTx)
    const broadcast = vi.fn(async () => { throw failure })
    const result = await executeCommunityParentGenesis({
      config: configFor(),
      reader,
      gates: authorizationFor(preview.fingerprint),
      signer: signerWith(async (value) => {
        candidate = value
        return signedBytesFor(value)
      }),
      broadcaster: { broadcast }
    })
    expect(result.status).toBe('broadcast-status-ambiguous')
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(reader.txCalls).toHaveLength(1)
  })

  it('distinguishes a definitive Chronik rejection from ambiguous transport', async () => {
    const preview = await prepareCommunityParentExecution({ config: configFor(), reader: new MockReader() })
    const reader = new MockReader(liveResponse(), liveResponse())
    let candidate: CommunityParentExecutionCandidate | undefined
    reader.validateImpl = async (rawTx) => chronikTxFor(candidate!, rawTx)
    const broadcast = vi.fn(async () => ({ status: 'rejected' as const }))
    const result = await executeCommunityParentGenesis({
      config: configFor(),
      reader,
      gates: authorizationFor(preview.fingerprint),
      signer: signerWith(async (value) => {
        candidate = value
        return signedBytesFor(value)
      }),
      broadcaster: { broadcast }
    })
    expect(result.status).toBe('broadcast-rejected')
    if (result.status !== 'broadcast-rejected') throw new Error('Expected definitive rejection.')
    expect(result.signedTxid).toMatch(/^[0-9a-f]{64}$/)
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(reader.txCalls).toHaveLength(1)
  })

  it('reports accepted/pending without inventing post-broadcast confirmation', async () => {
    const preview = await prepareCommunityParentExecution({ config: configFor(), reader: new MockReader() })
    const reader = new MockReader(liveResponse(), liveResponse())
    let candidate: CommunityParentExecutionCandidate | undefined
    reader.validateImpl = async (rawTx) => chronikTxFor(candidate!, rawTx)
    reader.txImpl = async (txid) => {
      if (txid === liveUtxo().outpoint.txid) return fundingTxFor(liveUtxo())
      throw new Error('not indexed yet')
    }
    const broadcast = vi.fn(async (rawTx: Uint8Array) => ({
      status: 'accepted' as const,
      txid: Tx.deser(rawTx).txid()
    }))
    const result = await executeCommunityParentGenesis({
      config: configFor(),
      reader,
      gates: authorizationFor(preview.fingerprint),
      signer: signerWith(async (value) => {
        candidate = value
        return signedBytesFor(value)
      }),
      broadcaster: { broadcast }
    })
    expect(result.status).toBe('broadcast-accepted-chain-verification-pending')
    expect(broadcast).toHaveBeenCalledTimes(1)
  })
})

describe('scope, API, and secret boundaries', () => {
  it('classifies only the installed client\'s decoded Chronik rejection as definitive', () => {
    expect(classifyChronikClientV3BroadcastFailure(
      new Error('Failed getting /broadcast-tx: txn-mempool-conflict')
    )).toBe('rejected')
    expect(classifyChronikClientV3BroadcastFailure(new Error('timeout'))).toBe('ambiguous')
    expect(classifyChronikClientV3BroadcastFailure(
      Object.assign(new Error('socket reset'), { code: 'ECONNRESET' })
    )).toBe('ambiguous')
    expect(classifyChronikClientV3BroadcastFailure({ status: 500 })).toBe('ambiguous')
  })

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
