import {
  ALL_BIP143,
  Address,
  Ecc,
  Script,
  Tx,
  UnsignedTx,
  calcTxFee,
  fromHex,
  isPushOp,
  parseSlp,
  sha256,
  sha256d,
  shaRmd160,
  toHex
} from 'ecash-lib'
import { FEE_RATE_SATS_PER_BYTE } from '../config/xecFees'
import {
  COMMUNITY_PARENT_DECIMALS,
  COMMUNITY_PARENT_DOCUMENT_HASH,
  COMMUNITY_PARENT_DUST_SATS,
  COMMUNITY_PARENT_INITIAL_QUANTITY,
  COMMUNITY_PARENT_MINT_BATON_VOUT,
  COMMUNITY_PARENT_TOKEN_NAME,
  COMMUNITY_PARENT_TOKEN_TICKER,
  COMMUNITY_PARENT_TOKEN_TYPE,
  assertCommunityParentGenesisConfig,
  buildCommunityParentGenesisPlan
} from './communityParentGenesis'
import type {
  CommunityParentFundingUtxo,
  CommunityParentGenesisConfig,
  CommunityParentGenesisPlan
} from './communityParentGenesis'

const CANONICAL_TXID = /^[0-9a-f]{64}$/
const CANONICAL_COMPRESSED_PUBLIC_KEY = /^(02|03)[0-9a-f]{64}$/
const CHRONIK_V3_BROADCAST_REJECTION_PREFIX = 'Failed getting /broadcast-tx: '
const UINT32_MAX = 0xffffffff
const SCHNORR_SIGNATURE_BYTES = 64
const P2PKH_SIGNED_INPUT_BYTES = 148
const TX_FIXED_BYTES = 8
const FEE_PER_KB = BigInt(Math.round(FEE_RATE_SATS_PER_BYTE * 1000))

export const COMMUNITY_PARENT_EXECUTION_FEE_PER_KB = FEE_PER_KB
export const COMMUNITY_PARENT_MAX_FEE_OVERPAY_SATS = COMMUNITY_PARENT_DUST_SATS - 1n

/**
 * Latest mainnet checkpoint published by Bitcoin ABC when this executor was
 * reviewed. Source (pinned source revision c37387a4d25b0a2cf886e2010d0023dd078ca43a):
 * src/networks/abc/checkpoints.cpp, "Obolensky activation".
 */
export const ECASH_MAINNET_EXECUTION_CHECKPOINT = Object.freeze({
  height: 949_200,
  hash: '000000000000000098694560815190dba8bbe2f06c08a7c23837df3c4886cba2'
})

export type CommunityParentExecutionGates = Readonly<{
  BROADCAST?: string
  CONFIRM_COMMUNITY_PARENT_GENESIS?: string
  CONFIRM_PLAN_SHA256?: string
}>

export interface CommunityParentChronikReader {
  readonly endpointLabel: string
  block(height: number): Promise<unknown>
  addressUtxos(address: string): Promise<unknown>
  /**
   * Chronik validateRawTx validates token/indexing structure. It is not a
   * substitute for local signature, mempool-policy, or consensus validation.
   */
  validateRawTx(rawTx: Uint8Array): Promise<unknown>
  tx(txid: string): Promise<unknown>
}

export interface CommunityParentSigner {
  /** Canonical compressed secp256k1 public key derived from the signing secret. */
  readonly publicKeyHex: string
  sign(candidate: CommunityParentExecutionCandidate): Promise<Uint8Array>
}

export type CommunityParentBroadcastOutcome =
  | Readonly<{ status: 'accepted'; txid: string }>
  | Readonly<{ status: 'rejected' }>

export interface CommunityParentBroadcaster {
  broadcast(rawTx: Uint8Array): Promise<CommunityParentBroadcastOutcome>
}

/**
 * chronik-client@3.7.0 converts a decoded protobuf error from a working
 * Chronik server into an Error with this fixed prefix and discards the HTTP
 * status and protobuf structure. Transport/failover failures use other error
 * shapes and remain ambiguous. Keep this compatibility shim at the adapter
 * boundary until the installed client exposes structured broadcast errors.
 */
export const classifyChronikClientV3BroadcastFailure = (
  error: unknown
): 'rejected' | 'ambiguous' =>
  error instanceof Error && error.message.startsWith(CHRONIK_V3_BROADCAST_REJECTION_PREFIX)
    ? 'rejected'
    : 'ambiguous'

export type CommunityParentExecutionCandidate = Readonly<{
  plan: CommunityParentGenesisPlan
  chronikEndpoint: string
  unsignedTxHex: string
  maximumFeeSats: bigint
  fingerprint: string
}>

export type CommunityParentExecutionResult =
  | Readonly<{
      status: 'dry-run'
      candidate: CommunityParentExecutionCandidate
    }>
  | Readonly<{
      status: 'broadcast-confirmed' | 'broadcast-accepted-chain-verification-pending'
      candidate: CommunityParentExecutionCandidate
      signedTxid: string
    }>
  | Readonly<{
      status: 'broadcast-status-ambiguous'
      candidate: CommunityParentExecutionCandidate
      signedTxid: string
    }>
  | Readonly<{
      status: 'broadcast-rejected'
      candidate: CommunityParentExecutionCandidate
      signedTxid: string
    }>

const asRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is malformed.`)
  }
  return value as Record<string, unknown>
}

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index])

const assertEndpointLabel: (endpointLabel: unknown) => asserts endpointLabel is string = (
  endpointLabel
) => {
  if (
    typeof endpointLabel !== 'string' ||
    endpointLabel.length === 0 ||
    endpointLabel.trim() !== endpointLabel ||
    [...endpointLabel].some((character) => {
      const code = character.charCodeAt(0)
      return code <= 0x20 || code === 0x7f
    })
  ) {
    throw new Error('Chronik endpoint label must be explicit.')
  }
}

const assertMainnetExecutionConfig = (config: CommunityParentGenesisConfig): void => {
  assertCommunityParentGenesisConfig(config)
  if (config.network !== 'mainnet') {
    throw new Error('Community Parent execution is restricted to mainnet.')
  }
}

const signerFundingScriptHex = (
  signer: CommunityParentSigner,
  fundingAddress: string
): string => {
  if (!CANONICAL_COMPRESSED_PUBLIC_KEY.test(signer.publicKeyHex)) {
    throw new Error('Signer public key must be canonical compressed secp256k1 hex.')
  }
  const publicKey = fromHex(signer.publicKeyHex)
  const signerScriptHex = toHex(Script.p2pkh(shaRmd160(publicKey)).bytecode)
  const fundingScriptHex = toHex(Address.parse(fundingAddress).toScript().bytecode)
  if (signerScriptHex !== fundingScriptHex) {
    throw new Error('The configured signing key does not control the funding address.')
  }
  return signerScriptHex
}

const assertCandidateControlledBySigner = (
  candidate: CommunityParentExecutionCandidate,
  signerScriptHex: string
): void => {
  if (
    candidate.plan.selectedInputs.length === 0 ||
    candidate.plan.selectedInputs.some((input) => input.outputScript !== signerScriptHex)
  ) {
    throw new Error('The configured signing key does not control every selected input.')
  }
}

const assertSelectedInputPrevouts = async (
  reader: CommunityParentChronikReader,
  candidate: CommunityParentExecutionCandidate,
  signerScriptHex: string
): Promise<void> => {
  try {
    for (const input of candidate.plan.selectedInputs) {
      const transaction = asRecord(
        await reader.tx(input.outpoint.txid),
        'Chronik funding transaction'
      )
      if (transaction.txid !== input.outpoint.txid || !Array.isArray(transaction.outputs)) {
        throw new Error('Chronik funding transaction is malformed.')
      }
      const output = asRecord(
        transaction.outputs[input.outpoint.outIdx],
        'Chronik funding transaction output'
      )
      if (
        output.sats !== input.sats ||
        output.outputScript !== signerScriptHex ||
        output.token !== undefined
      ) {
        throw new Error('Chronik funding prevout does not match the signing authority.')
      }
    }
  } catch {
    throw new Error('Chronik selected-input ownership revalidation failed closed.')
  }
}

const assertMainnetCheckpoint = async (reader: CommunityParentChronikReader): Promise<void> => {
  try {
    const block = asRecord(
      await reader.block(ECASH_MAINNET_EXECUTION_CHECKPOINT.height),
      'Chronik checkpoint block'
    )
    const blockInfo = asRecord(block.blockInfo, 'Chronik checkpoint block info')
    if (
      blockInfo.height !== ECASH_MAINNET_EXECUTION_CHECKPOINT.height ||
      blockInfo.hash !== ECASH_MAINNET_EXECUTION_CHECKPOINT.hash
    ) {
      throw new Error('Chronik endpoint is not serving the required eCash mainnet checkpoint.')
    }
  } catch {
    throw new Error('Chronik mainnet checkpoint verification failed closed.')
  }
}

const compactSizeLength = (value: number): number => {
  if (value < 0xfd) return 1
  if (value <= 0xffff) return 3
  if (value <= 0xffffffff) return 5
  return 9
}

const outputSizeFromHex = (scriptHex: string): number => {
  const scriptBytes = fromHex(scriptHex).length
  return 8 + compactSizeLength(scriptBytes) + scriptBytes
}

const maximumFeeForPlan = (plan: CommunityParentGenesisPlan): bigint => {
  const signedSize =
    TX_FIXED_BYTES +
    compactSizeLength(plan.selectedInputs.length) +
    plan.selectedInputs.length * P2PKH_SIGNED_INPUT_BYTES +
    compactSizeLength(plan.outputs.length) +
    plan.outputs.reduce((total, output) => total + outputSizeFromHex(output.scriptHex), 0)
  return calcTxFee(signedSize, FEE_PER_KB) + COMMUNITY_PARENT_MAX_FEE_OVERPAY_SATS
}

const sumInputSats = (plan: CommunityParentGenesisPlan): bigint =>
  plan.selectedInputs.reduce((total, input) => total + input.sats, 0n)

const sumOutputSats = (plan: CommunityParentGenesisPlan): bigint =>
  plan.outputs.reduce((total, output) => total + output.sats, 0n)

const assertCanonicalPlan = (plan: CommunityParentGenesisPlan): void => {
  if (
    plan.tokenType !== COMMUNITY_PARENT_TOKEN_TYPE ||
    plan.tokenName !== COMMUNITY_PARENT_TOKEN_NAME ||
    plan.tokenTicker !== COMMUNITY_PARENT_TOKEN_TICKER ||
    plan.decimals !== COMMUNITY_PARENT_DECIMALS ||
    plan.initialQuantity !== COMMUNITY_PARENT_INITIAL_QUANTITY ||
    plan.mintBatonVout !== COMMUNITY_PARENT_MINT_BATON_VOUT ||
    plan.documentHash !== COMMUNITY_PARENT_DOCUMENT_HASH
  ) {
    throw new Error('Community Parent canonical invariants changed before execution.')
  }
  if (plan.outputs.length !== 3 && plan.outputs.length !== 4) {
    throw new Error('Community Parent output layout is not canonical.')
  }
  const [genesis, token, baton, change] = plan.outputs
  if (
    genesis?.vout !== 0 ||
    genesis.kind !== 'slp-genesis' ||
    genesis.sats !== 0n ||
    genesis.scriptHex !== plan.opReturnHex ||
    token?.vout !== 1 ||
    token.kind !== 'initial-group-quantity' ||
    token.sats !== COMMUNITY_PARENT_DUST_SATS ||
    token.tokenAtoms !== COMMUNITY_PARENT_INITIAL_QUANTITY ||
    token.address !== plan.tokenDestinationAddress ||
    baton?.vout !== COMMUNITY_PARENT_MINT_BATON_VOUT ||
    baton.kind !== 'mint-baton' ||
    baton.sats !== COMMUNITY_PARENT_DUST_SATS ||
    baton.address !== plan.batonDestinationAddress
  ) {
    throw new Error('Community Parent fixed outputs are not canonical.')
  }
  if (
    (change !== undefined &&
      (change.vout !== 3 ||
        change.kind !== 'xec-change' ||
        change.sats < COMMUNITY_PARENT_DUST_SATS ||
        change.address !== plan.changeAddress)) ||
    plan.outputs.some((output, index) => output.vout !== index)
  ) {
    throw new Error('Community Parent change output is not canonical.')
  }
  const parsed = parseSlp(new Script(fromHex(plan.opReturnHex)))
  if (
    parsed?.txType !== 'GENESIS' ||
    parsed.tokenType !== COMMUNITY_PARENT_TOKEN_TYPE ||
    parsed.genesisInfo.tokenTicker !== COMMUNITY_PARENT_TOKEN_TICKER ||
    parsed.genesisInfo.tokenName !== COMMUNITY_PARENT_TOKEN_NAME ||
    parsed.genesisInfo.url !== plan.documentUri ||
    parsed.genesisInfo.hash !== COMMUNITY_PARENT_DOCUMENT_HASH ||
    parsed.genesisInfo.decimals !== COMMUNITY_PARENT_DECIMALS ||
    parsed.initialAtoms !== COMMUNITY_PARENT_INITIAL_QUANTITY ||
    parsed.mintBatonOutIdx !== COMMUNITY_PARENT_MINT_BATON_VOUT
  ) {
    throw new Error('Community Parent SLP GENESIS semantics are not canonical.')
  }
  const fundingScriptHex = toHex(Address.parse(plan.fundingAddress).toScript().bytecode)
  if (
    plan.selectedInputs.length === 0 ||
    plan.selectedInputs.some(
      (input) =>
        input.outputScript !== fundingScriptHex ||
        input.token !== undefined ||
        input.isCoinbase !== false
    )
  ) {
    throw new Error('Community Parent execution inputs are not pure XEC funding.')
  }
  const fee = sumInputSats(plan) - sumOutputSats(plan)
  if (fee < 0n || fee !== plan.estimatedFeeSats) {
    throw new Error('Community Parent fee or change accounting is inconsistent.')
  }
  if (fee > maximumFeeForPlan(plan)) {
    throw new Error('Community Parent fee exceeds the maximum policy guard.')
  }
}

const parseLiveFunding = (
  response: unknown,
  expectedScriptHex: string
): readonly CommunityParentFundingUtxo[] => {
  const payload = asRecord(response, 'Chronik UTXO response')
  if (payload.outputScript !== expectedScriptHex || !Array.isArray(payload.utxos)) {
    throw new Error('Chronik UTXO response does not match the funding address.')
  }
  const seen = new Set<string>()
  const pureXec: CommunityParentFundingUtxo[] = []
  for (const raw of payload.utxos) {
    const utxo = asRecord(raw, 'Chronik UTXO')
    const outpoint = asRecord(utxo.outpoint, 'Chronik UTXO outpoint')
    if (
      typeof outpoint.txid !== 'string' ||
      !CANONICAL_TXID.test(outpoint.txid) ||
      typeof outpoint.outIdx !== 'number' ||
      !Number.isInteger(outpoint.outIdx) ||
      outpoint.outIdx < 0 ||
      outpoint.outIdx > UINT32_MAX ||
      typeof utxo.sats !== 'bigint' ||
      utxo.sats <= 0n ||
      typeof utxo.isCoinbase !== 'boolean'
    ) {
      throw new Error('Chronik returned a malformed funding UTXO.')
    }
    const key = `${outpoint.txid}:${outpoint.outIdx}`
    if (seen.has(key)) throw new Error(`Chronik returned duplicate UTXO ${key}.`)
    seen.add(key)
    if (utxo.isCoinbase) continue
    if (utxo.token !== undefined) {
      asRecord(utxo.token, 'Chronik token annotation')
      continue
    }
    pureXec.push({
      outpoint: { txid: outpoint.txid, outIdx: outpoint.outIdx },
      sats: utxo.sats,
      outputScript: expectedScriptHex,
      isCoinbase: false
    })
  }
  return pureXec
}

const readLivePureXecFunding = async (
  config: CommunityParentGenesisConfig,
  reader: CommunityParentChronikReader
): Promise<readonly CommunityParentFundingUtxo[]> => {
  const expectedScriptHex = toHex(Address.parse(config.fundingAddress).toScript().bytecode)
  try {
    const response = await reader.addressUtxos(config.fundingAddress)
    return parseLiveFunding(response, expectedScriptHex)
  } catch {
    throw new Error('Chronik live UTXO revalidation failed closed.')
  }
}

const buildUnsignedTx = (plan: CommunityParentGenesisPlan): Tx =>
  new Tx({
    inputs: plan.selectedInputs.map((input) => ({
      prevOut: input.outpoint,
      signData: {
        sats: input.sats,
        outputScript: new Script(fromHex(input.outputScript))
      }
    })),
    outputs: plan.outputs.map((output) => ({
      sats: output.sats,
      script: new Script(fromHex(output.scriptHex))
    }))
  })

const canonicalFingerprintBytes = (params: {
  readonly plan: CommunityParentGenesisPlan
  readonly chronikEndpoint: string
  readonly unsignedTxHex: string
  readonly maximumFeeSats: bigint
}): Uint8Array => {
  const { plan } = params
  const commitment = {
    schema: 'xolosarmy-community-parent-execution/1',
    network: plan.network,
    chronikEndpoint: params.chronikEndpoint,
    fundingAddress: plan.fundingAddress,
    tokenDestinationAddress: plan.tokenDestinationAddress,
    batonDestinationAddress: plan.batonDestinationAddress,
    changeAddress: plan.changeAddress,
    selectedInputs: plan.selectedInputs.map((input) => ({
      txid: input.outpoint.txid,
      outIdx: input.outpoint.outIdx,
      sats: input.sats.toString(),
      outputScript: input.outputScript
    })),
    tokenType: plan.tokenType,
    tokenName: plan.tokenName,
    tokenTicker: plan.tokenTicker,
    decimals: plan.decimals,
    initialQuantity: plan.initialQuantity.toString(),
    mintBatonVout: plan.mintBatonVout,
    documentUri: plan.documentUri,
    documentHash: plan.documentHash,
    opReturnHex: plan.opReturnHex,
    outputs: plan.outputs.map((output) => ({
      vout: output.vout,
      kind: output.kind,
      sats: output.sats.toString(),
      scriptHex: output.scriptHex,
      address: output.address ?? null,
      tokenAtoms: output.tokenAtoms?.toString() ?? null
    })),
    feeRateSatsPerKb: FEE_PER_KB.toString(),
    estimatedFeeSats: plan.estimatedFeeSats.toString(),
    maximumFeeSats: params.maximumFeeSats.toString(),
    unsignedTxHex: params.unsignedTxHex
  }
  return new TextEncoder().encode(JSON.stringify(commitment))
}

const freezeCandidate = (
  candidate: CommunityParentExecutionCandidate
): CommunityParentExecutionCandidate => {
  for (const input of candidate.plan.selectedInputs) {
    Object.freeze(input.outpoint)
    Object.freeze(input)
  }
  for (const output of candidate.plan.outputs) Object.freeze(output)
  Object.freeze(candidate.plan.selectedInputs)
  Object.freeze(candidate.plan.outputs)
  Object.freeze(candidate.plan)
  return Object.freeze(candidate)
}

export const prepareCommunityParentExecution = async (params: {
  readonly config: CommunityParentGenesisConfig
  readonly reader: CommunityParentChronikReader
}): Promise<CommunityParentExecutionCandidate> => {
  assertEndpointLabel(params.reader.endpointLabel)
  const fundingUtxos = await readLivePureXecFunding(params.config, params.reader)
  const plan = buildCommunityParentGenesisPlan({ config: params.config, fundingUtxos })
  assertCanonicalPlan(plan)
  const unsignedTxHex = buildUnsignedTx(plan).toHex()
  const maximumFeeSats = maximumFeeForPlan(plan)
  const fingerprint = toHex(
    sha256(
      canonicalFingerprintBytes({
        plan,
        chronikEndpoint: params.reader.endpointLabel,
        unsignedTxHex,
        maximumFeeSats
      })
    )
  )
  return freezeCandidate({
    plan,
    chronikEndpoint: params.reader.endpointLabel,
    unsignedTxHex,
    maximumFeeSats,
    fingerprint
  })
}

const assertExecutionGates = (
  gates: CommunityParentExecutionGates,
  fingerprint: string
): 'dry-run' | 'execute' => {
  const supplied =
    gates.BROADCAST !== undefined ||
    gates.CONFIRM_COMMUNITY_PARENT_GENESIS !== undefined ||
    gates.CONFIRM_PLAN_SHA256 !== undefined
  if (!supplied) return 'dry-run'
  if (
    gates.BROADCAST !== '1' ||
    gates.CONFIRM_COMMUNITY_PARENT_GENESIS !== 'YES' ||
    gates.CONFIRM_PLAN_SHA256 !== fingerprint
  ) {
    throw new Error('Execution authorization is incomplete or the plan fingerprint does not match.')
  }
  return 'execute'
}

const hasExecutionIntent = (gates: CommunityParentExecutionGates): boolean =>
  gates.BROADCAST !== undefined ||
  gates.CONFIRM_COMMUNITY_PARENT_GENESIS !== undefined ||
  gates.CONFIRM_PLAN_SHA256 !== undefined

const assertSignedTxMatchesCandidate = (
  rawTx: Uint8Array,
  candidate: CommunityParentExecutionCandidate,
  expectedPublicKeyHex: string
): Tx => {
  let tx: Tx
  try {
    tx = Tx.deser(rawTx)
  } catch {
    throw new Error('Signer returned a malformed transaction.')
  }
  if (toHex(tx.ser()) !== toHex(rawTx)) {
    throw new Error('Signer returned non-canonical transaction bytes.')
  }
  const canonicalUnsignedTx = Tx.fromHex(candidate.unsignedTxHex)
  const txidHex = (txid: string | Uint8Array): string =>
    typeof txid === 'string' ? txid : toHex(txid.slice().reverse())
  if (
    tx.version !== canonicalUnsignedTx.version ||
    tx.locktime !== canonicalUnsignedTx.locktime ||
    tx.inputs.length !== canonicalUnsignedTx.inputs.length ||
    tx.outputs.length !== canonicalUnsignedTx.outputs.length
  ) {
    throw new Error('Signed transaction changed the canonical transaction shape.')
  }
  for (let index = 0; index < tx.inputs.length; index += 1) {
    const actual = tx.inputs[index]
    const expected = canonicalUnsignedTx.inputs[index]
    if (
      actual === undefined ||
      expected === undefined ||
      txidHex(actual.prevOut.txid) !== txidHex(expected.prevOut.txid) ||
      actual.prevOut.outIdx !== expected.prevOut.outIdx ||
      (actual.sequence ?? UINT32_MAX) !== (expected.sequence ?? UINT32_MAX)
    ) {
      throw new Error('Signed transaction changed a canonical input.')
    }
  }
  for (let index = 0; index < tx.outputs.length; index += 1) {
    const actual = tx.outputs[index]
    const expected = canonicalUnsignedTx.outputs[index]
    if (
      actual === undefined ||
      expected === undefined ||
      actual.sats !== expected.sats ||
      toHex(actual.script.bytecode) !== toHex(expected.script.bytecode)
    ) {
      throw new Error('Signed transaction changed a canonical output.')
    }
  }

  const expectedPublicKey = fromHex(expectedPublicKeyHex)
  const verificationTx = new Tx({
    version: tx.version,
    locktime: tx.locktime,
    inputs: tx.inputs.map((input, index) => {
      const expectedInput = candidate.plan.selectedInputs[index]
      if (expectedInput === undefined) {
        throw new Error('Signed transaction changed the canonical input count.')
      }
      return {
        prevOut: input.prevOut,
        script: input.script,
        sequence: input.sequence,
        signData: {
          sats: expectedInput.sats,
          outputScript: new Script(fromHex(expectedInput.outputScript))
        }
      }
    }),
    outputs: tx.outputs
  })
  const signatureUnsignedTx = UnsignedTx.fromTx(verificationTx)
  const ecc = new Ecc()
  verificationTx.inputs.forEach((input, index) => {
    const expectedInput = candidate.plan.selectedInputs[index]
    if (expectedInput === undefined) {
      throw new Error('Signed transaction changed the canonical input count.')
    }
    let signatureWithHashType: Uint8Array
    let publicKey: Uint8Array
    try {
      const operations = input.script?.ops()
      const signaturePush = operations?.next()
      const publicKeyPush = operations?.next()
      if (
        operations === undefined ||
        !isPushOp(signaturePush) ||
        !isPushOp(publicKeyPush) ||
        operations.next() !== undefined ||
        signaturePush.opcode !== SCHNORR_SIGNATURE_BYTES + 1 ||
        signaturePush.data.length !== SCHNORR_SIGNATURE_BYTES + 1 ||
        publicKeyPush.opcode !== 33 ||
        publicKeyPush.data.length !== 33
      ) {
        throw new Error('non-canonical P2PKH scriptSig')
      }
      signatureWithHashType = signaturePush.data
      publicKey = publicKeyPush.data
    } catch {
      throw new Error('Signed transaction contains a non-canonical P2PKH scriptSig.')
    }
    if (
      signatureWithHashType[SCHNORR_SIGNATURE_BYTES] !== (ALL_BIP143.toInt() & 0xff) ||
      !bytesEqual(publicKey, expectedPublicKey) ||
      toHex(Script.p2pkh(shaRmd160(publicKey)).bytecode) !== expectedInput.outputScript
    ) {
      throw new Error('Signed transaction P2PKH authority or sighash policy is invalid.')
    }
    try {
      const preimage = signatureUnsignedTx.inputAt(index).sigHashPreimage(ALL_BIP143)
      ecc.schnorrVerify(
        signatureWithHashType.slice(0, SCHNORR_SIGNATURE_BYTES),
        sha256d(preimage.bytes),
        publicKey
      )
    } catch {
      throw new Error('Signed transaction contains an invalid Schnorr signature.')
    }
  })

  const fee = sumInputSats(candidate.plan) - tx.outputs.reduce((sum, output) => sum + output.sats, 0n)
  const minimumFee = calcTxFee(tx.serSize(), FEE_PER_KB)
  if (
    fee !== candidate.plan.estimatedFeeSats ||
    fee < minimumFee ||
    fee > candidate.maximumFeeSats
  ) {
    throw new Error('Signed transaction fee violates the canonical fee policy.')
  }
  return tx
}

const expectTokenType = (value: unknown, number: number): void => {
  const tokenType = asRecord(value, 'Chronik token type')
  if (tokenType.protocol !== 'SLP' || tokenType.number !== number) {
    throw new Error('Chronik token type does not match the canonical transaction.')
  }
}

const assertChronikTxMatchesCandidate = (
  value: unknown,
  candidate: CommunityParentExecutionCandidate,
  signedTxid: string
): void => {
  try {
    const tx = asRecord(value, 'Chronik transaction')
    if (
      tx.txid !== signedTxid ||
      tx.tokenStatus !== 'TOKEN_STATUS_NORMAL' ||
      !Array.isArray(tx.inputs) ||
      !Array.isArray(tx.outputs) ||
      !Array.isArray(tx.tokenEntries) ||
      !Array.isArray(tx.tokenFailedParsings) ||
      tx.tokenFailedParsings.length !== 0 ||
      tx.inputs.length !== candidate.plan.selectedInputs.length ||
      tx.outputs.length !== candidate.plan.outputs.length ||
      tx.tokenEntries.length !== 1
    ) {
      throw new Error('Chronik transaction summary is not canonical.')
    }
    for (let index = 0; index < tx.inputs.length; index += 1) {
      const input = asRecord(tx.inputs[index], 'Chronik transaction input')
      const prevOut = asRecord(input.prevOut, 'Chronik transaction input outpoint')
      const expected = candidate.plan.selectedInputs[index]
      if (
        expected === undefined ||
        prevOut.txid !== expected.outpoint.txid ||
        prevOut.outIdx !== expected.outpoint.outIdx ||
        input.sats !== expected.sats ||
        input.outputScript !== expected.outputScript ||
        input.token !== undefined
      ) {
        throw new Error('Chronik transaction input is not canonical pure XEC funding.')
      }
    }
    for (let index = 0; index < tx.outputs.length; index += 1) {
      const output = asRecord(tx.outputs[index], 'Chronik transaction output')
      const expected = candidate.plan.outputs[index]
      if (
        expected === undefined ||
        output.sats !== expected.sats ||
        output.outputScript !== expected.scriptHex
      ) {
        throw new Error('Chronik transaction output is not canonical.')
      }
    }
    const entry = asRecord(tx.tokenEntries[0], 'Chronik token entry')
    expectTokenType(entry.tokenType, COMMUNITY_PARENT_TOKEN_TYPE)
    if (
      entry.tokenId !== signedTxid ||
      entry.txType !== 'GENESIS' ||
      entry.isInvalid !== false ||
      entry.actualBurnAtoms !== 0n ||
      entry.burnsMintBatons !== false
    ) {
      throw new Error('Chronik rejected the canonical NFT1 Group GENESIS semantics.')
    }
    const tokenOutput = asRecord(asRecord(tx.outputs[1], 'Chronik Group output').token, 'Chronik Group token')
    const batonOutput = asRecord(asRecord(tx.outputs[2], 'Chronik baton output').token, 'Chronik baton token')
    expectTokenType(tokenOutput.tokenType, COMMUNITY_PARENT_TOKEN_TYPE)
    expectTokenType(batonOutput.tokenType, COMMUNITY_PARENT_TOKEN_TYPE)
    if (
      tokenOutput.tokenId !== signedTxid ||
      tokenOutput.atoms !== COMMUNITY_PARENT_INITIAL_QUANTITY ||
      tokenOutput.isMintBaton !== false ||
      batonOutput.tokenId !== signedTxid ||
      batonOutput.atoms !== 0n ||
      batonOutput.isMintBaton !== true
    ) {
      throw new Error('Chronik NFT1 Group outputs are not canonical.')
    }
  } catch {
    throw new Error('Chronik transaction validation failed closed.')
  }
}

export const formatCommunityParentExecutionPreview = (
  candidate: CommunityParentExecutionCandidate
): string => {
  const { plan } = candidate
  const inputs = plan.selectedInputs
    .map((input) => `  - ${input.outpoint.txid}:${input.outpoint.outIdx} (${input.sats.toString()} sats)`)
    .join('\n')
  const outputs = plan.outputs
    .map((output) => `  - vout ${output.vout}: ${output.kind}; ${output.sats.toString()} sats; ${output.scriptHex}`)
    .join('\n')
  return [
    'Community Parent guarded execution preview',
    'MODE: DRY_RUN',
    `NETWORK: ${plan.network}`,
    `CHRONIK ENDPOINT: ${candidate.chronikEndpoint}`,
    `funding address: ${plan.fundingAddress}`,
    `token destination: ${plan.tokenDestinationAddress}`,
    `baton destination: ${plan.batonDestinationAddress}`,
    `change destination: ${plan.changeAddress}`,
    `canonical metadata hash: ${plan.documentHash}`,
    `documentUri: ${plan.documentUri}`,
    'selected live UTXOs:',
    inputs,
    `SLP type: ${plan.tokenType}`,
    `name: ${plan.tokenName}`,
    `ticker: ${plan.tokenTicker}`,
    `decimals: ${plan.decimals}`,
    `initial quantity: ${plan.initialQuantity.toString()}`,
    `baton vout: ${plan.mintBatonVout}`,
    'outputs:',
    outputs,
    `estimated fee: ${plan.estimatedFeeSats.toString()} sats`,
    `maximum fee: ${candidate.maximumFeeSats.toString()} sats`,
    `change: ${(plan.outputs.find((output) => output.kind === 'xec-change')?.sats ?? 0n).toString()} sats`,
    `PLAN FINGERPRINT: ${candidate.fingerprint}`,
    'NO SIGNING PERFORMED',
    'NO BROADCAST PERFORMED'
  ].join('\n')
}

export const executeCommunityParentGenesis = async (params: {
  readonly config: CommunityParentGenesisConfig
  readonly reader: CommunityParentChronikReader
  readonly gates: CommunityParentExecutionGates
  readonly signer?: CommunityParentSigner
  readonly broadcaster?: CommunityParentBroadcaster
  readonly onPreview?: (preview: string) => void
  readonly onSignedTxCandidate?: (txid: string) => void
}): Promise<CommunityParentExecutionResult> => {
  assertMainnetExecutionConfig(params.config)
  assertEndpointLabel(params.reader.endpointLabel)

  let signerScriptHex: string | undefined
  if (hasExecutionIntent(params.gates)) {
    if (params.signer === undefined || params.broadcaster === undefined) {
      throw new Error('Signing and broadcasting ports are required for execution authorization.')
    }
    signerScriptHex = signerFundingScriptHex(params.signer, params.config.fundingAddress)
  }

  await assertMainnetCheckpoint(params.reader)
  const previewCandidate = await prepareCommunityParentExecution({
    config: params.config,
    reader: params.reader
  })
  if (signerScriptHex !== undefined) {
    assertCandidateControlledBySigner(previewCandidate, signerScriptHex)
  }
  params.onPreview?.(formatCommunityParentExecutionPreview(previewCandidate))
  if (assertExecutionGates(params.gates, previewCandidate.fingerprint) === 'dry-run') {
    return { status: 'dry-run', candidate: previewCandidate }
  }
  const signer = params.signer
  const broadcaster = params.broadcaster
  if (signer === undefined || broadcaster === undefined || signerScriptHex === undefined) {
    throw new Error('Signing and broadcasting ports are unavailable after authorization.')
  }

  await assertMainnetCheckpoint(params.reader)
  const candidate = await prepareCommunityParentExecution({
    config: params.config,
    reader: params.reader
  })
  assertCandidateControlledBySigner(candidate, signerScriptHex)
  if (
    candidate.fingerprint !== previewCandidate.fingerprint ||
    candidate.fingerprint !== params.gates.CONFIRM_PLAN_SHA256
  ) {
    throw new Error('Live re-plan changed after preview; signing is forbidden.')
  }
  await assertSelectedInputPrevouts(params.reader, candidate, signerScriptHex)

  const signerResult = await signer.sign(candidate)
  if (!(signerResult instanceof Uint8Array)) {
    throw new Error('Signer returned malformed transaction bytes.')
  }
  const signedBytes = signerResult.slice()
  const signedTx = assertSignedTxMatchesCandidate(signedBytes, candidate, signer.publicKeyHex)
  const signedTxid = signedTx.txid()
  params.onSignedTxCandidate?.(signedTxid)

  let chronikPreflight: unknown
  try {
    chronikPreflight = await params.reader.validateRawTx(signedBytes.slice())
  } catch {
    throw new Error('Chronik pre-broadcast validation failed closed.')
  }
  assertChronikTxMatchesCandidate(chronikPreflight, candidate, signedTxid)

  let broadcastResponse: CommunityParentBroadcastOutcome
  try {
    broadcastResponse = await broadcaster.broadcast(signedBytes.slice())
  } catch {
    return { status: 'broadcast-status-ambiguous', candidate, signedTxid }
  }
  let broadcastRecord: Record<string, unknown>
  try {
    broadcastRecord = asRecord(broadcastResponse, 'Chronik broadcast outcome')
  } catch {
    return { status: 'broadcast-status-ambiguous', candidate, signedTxid }
  }
  if (broadcastRecord.status === 'rejected') {
    return { status: 'broadcast-rejected', candidate, signedTxid }
  }
  if (broadcastRecord.status !== 'accepted' || typeof broadcastRecord.txid !== 'string') {
    return { status: 'broadcast-status-ambiguous', candidate, signedTxid }
  }
  if (broadcastRecord.txid !== signedTxid) {
    throw new Error('Chronik returned a txid different from the signed transaction candidate.')
  }

  let observed: unknown
  try {
    observed = await params.reader.tx(signedTxid)
  } catch {
    return {
      status: 'broadcast-accepted-chain-verification-pending',
      candidate,
      signedTxid
    }
  }
  assertChronikTxMatchesCandidate(observed, candidate, signedTxid)
  return { status: 'broadcast-confirmed', candidate, signedTxid }
}
