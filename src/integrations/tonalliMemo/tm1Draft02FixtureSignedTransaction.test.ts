import { describe, expect, test } from 'vitest'
import type { UniversalContentHash } from '../../features/externalSign/contentHash'
import { encodeTm1Draft02Post } from './tm1Draft02'
import {
  TM1_DRAFT_02_AUTHOR_INPUT_INDEX,
  TM1_DRAFT_02_CANDIDATE_ENVIRONMENT,
  TM1_DRAFT_02_LOCKTIME,
  TM1_DRAFT_02_SEQUENCE,
  TM1_DRAFT_02_SIGHASH_POLICY,
  TM1_DRAFT_02_TX_VERSION,
  createTm1Draft02Candidate,
  type Tm1Draft02Candidate
} from './tm1Draft02Candidate'
import {
  Tm1Draft02FixtureSignedTransactionError,
  auditTm1Draft02FixtureSignedTransaction,
  createTm1Draft02DeterministicFixtureSignedTransaction,
  parseTm1Draft02FixtureSignedTransaction
} from './tm1Draft02FixtureSignedTransaction'

const AUTHOR_SCRIPT = `76a914${'11'.repeat(20)}88ac`
const AUTHOR_TXID = 'aa'.repeat(32)
const FUNDING_TXID = 'bb'.repeat(32)
const CONTENT_HASH = `sha256:${'44'.repeat(32)}` as UniversalContentHash

function candidate(overrides: Partial<Parameters<typeof createTm1Draft02Candidate>[0]> = {}): Tm1Draft02Candidate {
  const post = encodeTm1Draft02Post({
    eventData: 'Signed fixture audit',
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
        outIdx: 0,
        sequence: TM1_DRAFT_02_SEQUENCE,
        sats: 7_000n,
        lockingScriptHex: AUTHOR_SCRIPT
      },
      {
        txid: FUNDING_TXID,
        outIdx: 1,
        sequence: TM1_DRAFT_02_SEQUENCE,
        sats: 4_000n,
        lockingScriptHex: AUTHOR_SCRIPT
      }
    ],
    outputs: [
      { sats: 0n, scriptHex: post.scriptHex },
      { sats: 10_000n, scriptHex: AUTHOR_SCRIPT }
    ],
    dustSats: 546n,
    maxFeeSats: 2_000n,
    sighashPolicy: TM1_DRAFT_02_SIGHASH_POLICY,
    ...overrides
  })
}

function signed(value = candidate()): Uint8Array {
  return createTm1Draft02DeterministicFixtureSignedTransaction({
    candidate: value,
    contentHash: CONTENT_HASH
  })
}

describe('TM1 Draft 0.2 deterministic fixture signed transaction audit', () => {
  test('parses and audits deterministic fixture attestations on every input', () => {
    const value = candidate()
    const bytes = signed(value)
    const parsed = parseTm1Draft02FixtureSignedTransaction(bytes)
    const audited = auditTm1Draft02FixtureSignedTransaction({
      candidate: value,
      contentHash: CONTENT_HASH,
      signedTransactionBytes: bytes
    })

    expect(parsed.inputs).toHaveLength(2)
    expect(parsed.inputs.every(input => input.scriptSigHex.length > 0)).toBe(true)
    expect(parsed.outputs.map(output => output.scriptHex)).toEqual(
      value.outputs.map(output => output.scriptHex)
    )
    expect(audited.feeSats).toBe(1_000n)
  })

  test('rejects trailing bytes and truncation', () => {
    const bytes = signed()
    expect(() => parseTm1Draft02FixtureSignedTransaction(
      new Uint8Array([...bytes, 0])
    )).toThrowError(Tm1Draft02FixtureSignedTransactionError)
    expect(() => parseTm1Draft02FixtureSignedTransaction(
      bytes.slice(0, -1)
    )).toThrowError(Tm1Draft02FixtureSignedTransactionError)
  })

  test('rejects outpoint and sequence substitutions', () => {
    const original = candidate()
    const changedOutpoint = candidate({
      inputs: [
        { ...original.inputs[0]!, outIdx: 9 },
        original.inputs[1]!
      ]
    })
    expect(() => auditTm1Draft02FixtureSignedTransaction({
      candidate: original,
      contentHash: CONTENT_HASH,
      signedTransactionBytes: signed(changedOutpoint)
    })).toThrow('INPUT_OUTPOINT_MISMATCH')

    const changedSequence = candidate({
      inputs: [
        { ...original.inputs[0]!, sequence: 0xfffffffe },
        original.inputs[1]!
      ]
    })
    expect(() => auditTm1Draft02FixtureSignedTransaction({
      candidate: original,
      contentHash: CONTENT_HASH,
      signedTransactionBytes: signed(changedSequence)
    })).toThrow('INPUT_SEQUENCE_MISMATCH')
  })

  test('rejects output amount and script substitutions', () => {
    const original = candidate()
    const amountChanged = candidate({
      outputs: [original.outputs[0], { sats: 9_900n, scriptHex: AUTHOR_SCRIPT }]
    })
    expect(() => auditTm1Draft02FixtureSignedTransaction({
      candidate: original,
      contentHash: CONTENT_HASH,
      signedTransactionBytes: signed(amountChanged)
    })).toThrow('OUTPUT_SATS_MISMATCH')

    const otherScript = `76a914${'33'.repeat(20)}88ac`
    const raw = signed(original)
    const altered = new Uint8Array(raw)
    const originalScript = hexToBytes(AUTHOR_SCRIPT)
    const replacement = hexToBytes(otherScript)
    const offset = findLastSubarray(altered, originalScript)
    altered.set(replacement, offset)
    expect(() => auditTm1Draft02FixtureSignedTransaction({
      candidate: original,
      contentHash: CONTENT_HASH,
      signedTransactionBytes: altered
    })).toThrow('OUTPUT_SCRIPT_MISMATCH')
  })

  test('rejects a content hash substitution', () => {
    const value = candidate()
    const bytes = signed(value)
    const otherHash = `sha256:${'55'.repeat(32)}` as UniversalContentHash
    expect(() => auditTm1Draft02FixtureSignedTransaction({
      candidate: value,
      contentHash: otherHash,
      signedTransactionBytes: bytes
    })).toThrow('FIXTURE_ATTESTATION_MISMATCH')
  })
})

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)!.map(byte => Number.parseInt(byte, 16)))
}

function findLastSubarray(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let index = haystack.length - needle.length; index >= 0; index -= 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) continue outer
    }
    return index
  }
  throw new Error('Subarray not found')
}
