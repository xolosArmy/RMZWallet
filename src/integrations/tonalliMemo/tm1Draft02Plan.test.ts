import { describe, expect, it } from 'vitest'
import { encodeTm1Draft02Post } from './tm1Draft02'
import {
  TM1_DRAFT_02_STANDARD_AUTHOR_INPUT_INDEX,
  Tm1Draft02PlanError,
  estimateTm1Draft02TransactionSizeBytes,
  planTm1Draft02Post
} from './tm1Draft02Plan'

const ACTIVE_PKH = '11'.repeat(20)
const OTHER_PKH = '22'.repeat(20)
const ACTIVE_SCRIPT = `76a914${ACTIVE_PKH}88ac`
const OTHER_SCRIPT = `76a914${OTHER_PKH}88ac`

const utxo = (
  txidByte: string,
  outIdx: number,
  sats: bigint,
  lockingScriptHex = ACTIVE_SCRIPT,
  token: unknown | null = null
) => ({
  txid: txidByte.repeat(64),
  outIdx,
  sats,
  lockingScriptHex,
  token
})

describe('TM1 Draft 0.2 deterministic funding plan', () => {
  it('places the deterministic active-identity UTXO at author input zero', () => {
    const preview = encodeTm1Draft02Post({ eventData: 'Tonalli' })
    const plan = planTm1Draft02Post({
      preview,
      activeLockingScriptHex: ACTIVE_SCRIPT,
      feeRateSatsPerByte: 1,
      utxos: [
        utxo('b', 1, 4_000n),
        utxo('a', 0, 4_000n),
        utxo('c', 0, 3_000n)
      ]
    })

    expect(plan.authorInputIndex).toBe(TM1_DRAFT_02_STANDARD_AUTHOR_INPUT_INDEX)
    expect(plan.authorPublicKeyHashHex).toBe(ACTIVE_PKH)
    expect(plan.inputs).toHaveLength(1)
    expect(plan.inputs[0]).toMatchObject({
      index: 0,
      role: 'author',
      txid: 'a'.repeat(64),
      outIdx: 0,
      sats: 4_000n
    })
    expect(plan.outputs[0]).toEqual({
      index: 0,
      kind: 'op_return',
      sats: 0n,
      scriptHex: preview.scriptHex
    })
    expect(plan.outputs[1]).toMatchObject({
      index: 1,
      kind: 'change',
      scriptHex: ACTIVE_SCRIPT
    })
  })

  it('excludes token UTXOs and UTXOs belonging to another locking script', () => {
    const preview = encodeTm1Draft02Post({ eventData: 'Identidad activa' })
    const plan = planTm1Draft02Post({
      preview,
      activeLockingScriptHex: ACTIVE_SCRIPT,
      feeRateSatsPerByte: 1,
      utxos: [
        utxo('a', 0, 50_000n, ACTIVE_SCRIPT, { tokenId: 'token' }),
        utxo('b', 0, 50_000n, OTHER_SCRIPT),
        utxo('c', 0, 2_000n)
      ]
    })

    expect(plan.inputs).toHaveLength(1)
    expect(plan.inputs[0].txid).toBe('c'.repeat(64))
  })

  it('adds deterministic funding inputs until fee plus non-dust change are covered', () => {
    const preview = encodeTm1Draft02Post({ eventData: 'a'.repeat(80) })
    const feeRateSatsPerByte = 2
    const oneInputSize = estimateTm1Draft02TransactionSizeBytes(1, preview.scriptByteLength)
    const twoInputSize = estimateTm1Draft02TransactionSizeBytes(2, preview.scriptByteLength)
    const oneInputFee = BigInt(Math.ceil(oneInputSize * feeRateSatsPerByte))
    const twoInputFee = BigInt(Math.ceil(twoInputSize * feeRateSatsPerByte))
    const firstSats = oneInputFee + 545n

    const plan = planTm1Draft02Post({
      preview,
      activeLockingScriptHex: ACTIVE_SCRIPT,
      feeRateSatsPerByte,
      dustSats: 546n,
      utxos: [
        utxo('a', 0, firstSats),
        utxo('b', 0, 2_000n)
      ]
    })

    expect(plan.inputs).toHaveLength(2)
    expect(plan.inputs.map((input) => input.role)).toEqual(['author', 'funding'])
    expect(plan.estimatedSizeBytes).toBe(twoInputSize)
    expect(plan.estimatedFeeSats).toBe(twoInputFee)
    expect(plan.changeSats).toBe(firstSats + 2_000n - twoInputFee)
    expect(plan.changeSats).toBeGreaterThanOrEqual(546n)
  })

  it('rejects nonzero author indexes, duplicate outpoints and insufficient active funds', () => {
    const nonzeroPreview = encodeTm1Draft02Post({ eventData: 'x', authorInputIndex: 1 })
    const zeroPreview = encodeTm1Draft02Post({ eventData: 'x' })

    const cases = [
      {
        code: 'AUTHOR_INPUT_INDEX_MUST_BE_ZERO',
        run: () => planTm1Draft02Post({
          preview: nonzeroPreview,
          activeLockingScriptHex: ACTIVE_SCRIPT,
          utxos: [utxo('a', 0, 10_000n)]
        })
      },
      {
        code: 'DUPLICATE_OUTPOINT',
        run: () => planTm1Draft02Post({
          preview: zeroPreview,
          activeLockingScriptHex: ACTIVE_SCRIPT,
          utxos: [utxo('a', 0, 10_000n), utxo('a', 0, 9_000n)]
        })
      },
      {
        code: 'INSUFFICIENT_FUNDS',
        run: () => planTm1Draft02Post({
          preview: zeroPreview,
          activeLockingScriptHex: ACTIVE_SCRIPT,
          feeRateSatsPerByte: 10,
          utxos: [utxo('a', 0, 600n)]
        })
      }
    ] as const

    for (const testCase of cases) {
      expect(testCase.run).toThrowError(Tm1Draft02PlanError)
      try {
        testCase.run()
      } catch (error) {
        expect(error).toBeInstanceOf(Tm1Draft02PlanError)
        expect((error as Tm1Draft02PlanError).code).toBe(testCase.code)
      }
    }
  })
})
