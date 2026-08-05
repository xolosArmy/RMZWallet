import { describe, expect, it } from 'vitest'
import { encodeTm1Draft02Post } from './tm1Draft02'
import {
  TM1_DRAFT_02_AUTHOR_INPUT_INDEX,
  TM1_DRAFT_02_CANDIDATE_ENVIRONMENT,
  TM1_DRAFT_02_LOCKTIME,
  TM1_DRAFT_02_SEQUENCE,
  TM1_DRAFT_02_SIGHASH_POLICY,
  TM1_DRAFT_02_TX_VERSION,
  createTm1Draft02Candidate,
  encodeTm1Draft02CandidateEffectiveContent,
  type Tm1Draft02Candidate
} from './tm1Draft02Candidate'
import {
  Tm1Draft02UnsignedTransactionError,
  auditTm1Draft02UnsignedTransaction,
  decodeTm1Draft02CandidateEffectiveContent,
  encodeTm1Draft02UnsignedTransactionEnvelope,
  parseTm1Draft02UnsignedTransaction,
  serializeTm1Draft02UnsignedTransaction
} from './tm1Draft02UnsignedTransaction'

const AUTHOR_SCRIPT = `76a914${'11'.repeat(20)}88ac`
const SECOND_TXID = '22'.repeat(32)
const AUTHOR_TXID = 'aa'.repeat(32)

function candidate(overrides: Partial<Parameters<typeof createTm1Draft02Candidate>[0]> = {}): Tm1Draft02Candidate {
  const tm1 = encodeTm1Draft02Post({
    eventData: 'Tonalli fixture',
    authorInputIndex: TM1_DRAFT_02_AUTHOR_INPUT_INDEX
  })
  return createTm1Draft02Candidate({
    environment: TM1_DRAFT_02_CANDIDATE_ENVIRONMENT,
    transactionVersion: TM1_DRAFT_02_TX_VERSION,
    locktime: TM1_DRAFT_02_LOCKTIME,
    authorInputIndex: TM1_DRAFT_02_AUTHOR_INPUT_INDEX,
    authorLockingScriptHex: AUTHOR_SCRIPT,
    inputs: [
      {
        txid: AUTHOR_TXID,
        outIdx: 1,
        sequence: TM1_DRAFT_02_SEQUENCE,
        sats: 7_000n,
        lockingScriptHex: AUTHOR_SCRIPT
      },
      {
        txid: SECOND_TXID,
        outIdx: 2,
        sequence: TM1_DRAFT_02_SEQUENCE,
        sats: 4_000n,
        lockingScriptHex: AUTHOR_SCRIPT
      }
    ],
    outputs: [
      { sats: 0n, scriptHex: tm1.scriptHex },
      { sats: 10_000n, scriptHex: AUTHOR_SCRIPT }
    ],
    dustSats: 546n,
    maxFeeSats: 2_000n,
    sighashPolicy: TM1_DRAFT_02_SIGHASH_POLICY,
    ...overrides
  })
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action()
    throw new Error('Expected action to throw')
  } catch (error) {
    expect(error).toBeInstanceOf(Tm1Draft02UnsignedTransactionError)
    expect((error as Tm1Draft02UnsignedTransactionError).code).toBe(code)
  }
}

function replaceUint32(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  const altered = new Uint8Array(bytes)
  altered[offset] = value & 0xff
  altered[offset + 1] = (value >>> 8) & 0xff
  altered[offset + 2] = (value >>> 16) & 0xff
  altered[offset + 3] = (value >>> 24) & 0xff
  return altered
}

describe('TM1 Draft 0.2 unsigned deterministic fixture transaction', () => {
  it('strictly decodes canonical effectiveContent and preserves its byte identity', () => {
    const original = candidate()
    const effectiveContent = encodeTm1Draft02CandidateEffectiveContent(original)
    const decoded = decodeTm1Draft02CandidateEffectiveContent(effectiveContent)

    expect(decoded).toEqual(original)
    expect(encodeTm1Draft02CandidateEffectiveContent(decoded)).toEqual(effectiveContent)
  })

  it('rejects trailing or truncated effectiveContent', () => {
    const bytes = encodeTm1Draft02CandidateEffectiveContent(candidate())
    expectCode(
      () => decodeTm1Draft02CandidateEffectiveContent(new Uint8Array([...bytes, 0])),
      'INVALID_EFFECTIVE_CONTENT'
    )
    expectCode(
      () => decodeTm1Draft02CandidateEffectiveContent(bytes.slice(0, -1)),
      'INVALID_EFFECTIVE_CONTENT'
    )
  })

  it('serializes and independently parses an unsigned transaction with empty scriptSigs', () => {
    const original = candidate()
    const bytes = serializeTm1Draft02UnsignedTransaction(original)
    const parsed = parseTm1Draft02UnsignedTransaction(bytes)

    expect(parsed.transactionVersion).toBe(TM1_DRAFT_02_TX_VERSION)
    expect(parsed.locktime).toBe(TM1_DRAFT_02_LOCKTIME)
    expect(parsed.inputs.map(input => [input.txid, input.outIdx, input.sequence, input.scriptSigHex])).toEqual([
      [AUTHOR_TXID, 1, TM1_DRAFT_02_SEQUENCE, ''],
      [SECOND_TXID, 2, TM1_DRAFT_02_SEQUENCE, '']
    ])
    expect(parsed.outputs.map(output => [output.sats, output.scriptHex])).toEqual(
      original.outputs.map(output => [output.sats, output.scriptHex])
    )
  })

  it('audits every committed field and returns a domain-separated envelope', () => {
    const original = candidate()
    const effectiveContent = encodeTm1Draft02CandidateEffectiveContent(original)
    const bytes = serializeTm1Draft02UnsignedTransaction(original)
    const audited = auditTm1Draft02UnsignedTransaction({ effectiveContent, unsignedTransactionBytes: bytes })

    expect(audited.candidate).toEqual(original)
    expect(audited.transaction.inputs[0]?.txid).toBe(AUTHOR_TXID)
    expect(audited.transaction.outputs[0]?.scriptHex).toBe(original.outputs[0].scriptHex)
    expect(audited.transaction.outputs[1]?.scriptHex).toBe(AUTHOR_SCRIPT)
    expect(audited.feeSats).toBe(1_000n)
    expect(audited.unsignedTransactionEnvelope).toEqual(
      encodeTm1Draft02UnsignedTransactionEnvelope(original, bytes)
    )
  })

  it('rejects a non-minimal CompactSize input count', () => {
    const bytes = serializeTm1Draft02UnsignedTransaction(candidate())
    const nonMinimal = new Uint8Array([
      ...bytes.slice(0, 4),
      0xfd, 0x02, 0x00,
      ...bytes.slice(5)
    ])
    expectCode(() => parseTm1Draft02UnsignedTransaction(nonMinimal), 'INVALID_UNSIGNED_TRANSACTION')
  })

  it('rejects a non-empty scriptSig before signing', () => {
    const bytes = serializeTm1Draft02UnsignedTransaction(candidate())
    const firstScriptLengthOffset = 4 + 1 + 32 + 4
    const altered = new Uint8Array([
      ...bytes.slice(0, firstScriptLengthOffset),
      1,
      0x51,
      ...bytes.slice(firstScriptLengthOffset + 1)
    ])
    expectCode(
      () => auditTm1Draft02UnsignedTransaction({
        effectiveContent: encodeTm1Draft02CandidateEffectiveContent(candidate()),
        unsignedTransactionBytes: altered
      }),
      'INVALID_UNSIGNED_TRANSACTION'
    )
  })

  it('rejects transaction version and locktime substitutions', () => {
    const original = candidate()
    const bytes = serializeTm1Draft02UnsignedTransaction(original)
    const effectiveContent = encodeTm1Draft02CandidateEffectiveContent(original)

    expectCode(
      () => auditTm1Draft02UnsignedTransaction({
        effectiveContent,
        unsignedTransactionBytes: replaceUint32(bytes, 0, 1)
      }),
      'TRANSACTION_VERSION_MISMATCH'
    )
    expectCode(
      () => auditTm1Draft02UnsignedTransaction({
        effectiveContent,
        unsignedTransactionBytes: replaceUint32(bytes, bytes.length - 4, 1)
      }),
      'LOCKTIME_MISMATCH'
    )
  })

  it('rejects outpoint and sequence substitutions including author input zero', () => {
    const original = candidate()
    const bytes = serializeTm1Draft02UnsignedTransaction(original)
    const effectiveContent = encodeTm1Draft02CandidateEffectiveContent(original)
    const outIdxOffset = 4 + 1 + 32
    const sequenceOffset = outIdxOffset + 4 + 1

    expectCode(
      () => auditTm1Draft02UnsignedTransaction({
        effectiveContent,
        unsignedTransactionBytes: replaceUint32(bytes, outIdxOffset, 9)
      }),
      'INPUT_OUTPOINT_MISMATCH'
    )
    expectCode(
      () => auditTm1Draft02UnsignedTransaction({
        effectiveContent,
        unsignedTransactionBytes: replaceUint32(bytes, sequenceOffset, 0)
      }),
      'INPUT_SEQUENCE_MISMATCH'
    )
  })

  it('rejects an altered TM1 OP_RETURN', () => {
    const original = candidate()
    const altered = candidate({
      outputs: [
        original.outputs[0],
        { sats: 9_999n, scriptHex: AUTHOR_SCRIPT }
      ]
    })
    const bytes = serializeTm1Draft02UnsignedTransaction(altered)

    expectCode(
      () => auditTm1Draft02UnsignedTransaction({
        effectiveContent: encodeTm1Draft02CandidateEffectiveContent(original),
        unsignedTransactionBytes: bytes
      }),
      'OUTPUT_SATS_MISMATCH'
    )
  })

  it('rejects change script and amount substitutions', () => {
    const original = candidate()
    const tm1 = original.outputs[0]
    const otherScript = `76a914${'33'.repeat(20)}88ac`
    const amountChanged = candidate({
      inputs: original.inputs.map(input => ({
        txid: input.txid,
        outIdx: input.outIdx,
        sequence: input.sequence,
        sats: input.sats,
        lockingScriptHex: input.lockingScriptHex
      })),
      outputs: [tm1, { sats: 9_900n, scriptHex: AUTHOR_SCRIPT }],
      maxFeeSats: 2_000n
    })
    const bytes = serializeTm1Draft02UnsignedTransaction(amountChanged)
    expectCode(
      () => auditTm1Draft02UnsignedTransaction({
        effectiveContent: encodeTm1Draft02CandidateEffectiveContent(original),
        unsignedTransactionBytes: bytes
      }),
      'OUTPUT_SATS_MISMATCH'
    )

    const raw = serializeTm1Draft02UnsignedTransaction(original)
    const scriptHex = AUTHOR_SCRIPT
    const script = Uint8Array.from(scriptHex.match(/../g)!.map(byte => Number.parseInt(byte, 16)))
    const replacement = Uint8Array.from(otherScript.match(/../g)!.map(byte => Number.parseInt(byte, 16)))
    const offset = findSubarray(raw, script)
    const scriptChanged = new Uint8Array(raw)
    scriptChanged.set(replacement, offset)
    expectCode(
      () => auditTm1Draft02UnsignedTransaction({
        effectiveContent: encodeTm1Draft02CandidateEffectiveContent(original),
        unsignedTransactionBytes: scriptChanged
      }),
      'OUTPUT_SCRIPT_MISMATCH'
    )
  })

  it('rejects input count and output count substitutions', () => {
    const original = candidate()
    const bytes = serializeTm1Draft02UnsignedTransaction(original)
    const effectiveContent = encodeTm1Draft02CandidateEffectiveContent(original)

    const oneInputCandidate = candidate({ inputs: [original.inputs[0]!] })
    expectCode(
      () => auditTm1Draft02UnsignedTransaction({
        effectiveContent,
        unsignedTransactionBytes: serializeTm1Draft02UnsignedTransaction(oneInputCandidate)
      }),
      'INPUT_COUNT_MISMATCH'
    )

    const outputCountOffset = locateOutputCount(bytes, original.inputs.length)
    const noOutputs = new Uint8Array(bytes)
    noOutputs[outputCountOffset] = 0
    expectCode(() => parseTm1Draft02UnsignedTransaction(noOutputs), 'INVALID_UNSIGNED_TRANSACTION')
  })
})

function serializeTm1Draft02UnsignedTransaction(value: Tm1Draft02Candidate): Uint8Array {
  return serializeTm1Draft02UnsignedTransactionImported(value)
}

import { serializeTm1Draft02UnsignedTransaction as serializeTm1Draft02UnsignedTransactionImported } from './tm1Draft02UnsignedTransaction'

function findSubarray(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) continue outer
    }
    return index
  }
  throw new Error('Subarray not found')
}

function locateOutputCount(bytes: Uint8Array, inputCount: number): number {
  let offset = 5
  for (let index = 0; index < inputCount; index += 1) {
    offset += 32 + 4
    const scriptLength = bytes[offset] as number
    offset += 1 + scriptLength + 4
  }
  return offset
}
