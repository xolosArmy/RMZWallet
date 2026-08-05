import { describe, expect, it } from 'vitest'
import {
  TM1_DRAFT_02_AUTHOR_INPUT_INDEX,
  TM1_DRAFT_02_CANDIDATE_ENVIRONMENT,
  TM1_DRAFT_02_LOCKTIME,
  TM1_DRAFT_02_SEQUENCE,
  TM1_DRAFT_02_SIGHASH_POLICY,
  TM1_DRAFT_02_TX_VERSION,
  Tm1Draft02CandidateError,
  createTm1Draft02Candidate,
  encodeTm1Draft02CandidateEffectiveContent,
  revalidateTm1Draft02Candidate
} from './tm1Draft02Candidate'
import type {
  CreateTm1Draft02CandidateInput,
  Tm1Draft02Candidate,
  Tm1Draft02CandidateErrorCode,
  Tm1Draft02FreshUtxo
} from './tm1Draft02Candidate'

const TXID_A = 'aa'.repeat(32)
const TXID_B = 'bb'.repeat(32)
const AUTHOR_SCRIPT = `76a914${'11'.repeat(20)}88ac`
const OTHER_SCRIPT = `76a914${'22'.repeat(20)}88ac`
const TM1_POST_SCRIPT = '6a04544d4d000401010078'

function candidateInput(
  overrides: Partial<CreateTm1Draft02CandidateInput> = {}
): CreateTm1Draft02CandidateInput {
  return {
    environment: TM1_DRAFT_02_CANDIDATE_ENVIRONMENT,
    transactionVersion: TM1_DRAFT_02_TX_VERSION,
    locktime: TM1_DRAFT_02_LOCKTIME,
    authorInputIndex: TM1_DRAFT_02_AUTHOR_INPUT_INDEX,
    authorLockingScriptHex: AUTHOR_SCRIPT,
    inputs: [
      {
        txid: TXID_A,
        outIdx: 0,
        sequence: TM1_DRAFT_02_SEQUENCE,
        sats: 5_000n,
        lockingScriptHex: AUTHOR_SCRIPT
      },
      {
        txid: TXID_B,
        outIdx: 1,
        sequence: TM1_DRAFT_02_SEQUENCE,
        sats: 2_000n,
        lockingScriptHex: AUTHOR_SCRIPT
      }
    ],
    outputs: [
      { sats: 0n, scriptHex: TM1_POST_SCRIPT },
      { sats: 6_700n, scriptHex: AUTHOR_SCRIPT }
    ],
    dustSats: 546n,
    maxFeeSats: 500n,
    sighashPolicy: TM1_DRAFT_02_SIGHASH_POLICY,
    ...overrides
  }
}

function expectCode(run: () => unknown, code: Tm1Draft02CandidateErrorCode): void {
  try {
    run()
    throw new Error(`Expected ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(Tm1Draft02CandidateError)
    expect((error as Tm1Draft02CandidateError).code).toBe(code)
  }
}

function freshUtxos(candidate: Tm1Draft02Candidate): Tm1Draft02FreshUtxo[] {
  return candidate.inputs.map(candidateInputItem => ({
    txid: candidateInputItem.txid,
    outIdx: candidateInputItem.outIdx,
    sats: candidateInputItem.sats,
    lockingScriptHex: candidateInputItem.lockingScriptHex
  }))
}

describe('TM1 Draft 0.2 deterministic regtest candidate', () => {
  it('constructs a deeply frozen candidate and derives the fee from accounting', () => {
    const candidate = createTm1Draft02Candidate(candidateInput())

    expect(candidate.environment).toBe('deterministic-regtest-fixture')
    expect(candidate.authorInputIndex).toBe(0)
    expect(candidate.inputs[0].role).toBe('author')
    expect(candidate.inputs[1].role).toBe('funding')
    expect(candidate.outputs[0].role).toBe('tm1_op_return')
    expect(candidate.outputs[1].role).toBe('change')
    expect(candidate.feePolicy.feeSats).toBe(300n)
    expect(Object.isFrozen(candidate)).toBe(true)
    expect(Object.isFrozen(candidate.inputs)).toBe(true)
    expect(Object.isFrozen(candidate.inputs[0])).toBe(true)
    expect(Object.isFrozen(candidate.outputs)).toBe(true)
    expect(Object.isFrozen(candidate.feePolicy)).toBe(true)
  })

  it('produces canonical Uint8Array content with domain separation', () => {
    const candidate = createTm1Draft02Candidate(candidateInput())
    const content = encodeTm1Draft02CandidateEffectiveContent(candidate)
    const text = new TextDecoder().decode(content)

    expect(content).toBeInstanceOf(Uint8Array)
    expect(text).toContain('TONALLI\u0000TM1-DRAFT-02-CANDIDATE\u0000')
    expect(text).toContain('tonalli.tm1-candidate')
    expect(text).toContain('deterministic-regtest-fixture')
    expect(text).not.toContain('mainnet')
  })

  it('normalizes equivalent hexadecimal and ignores caller property insertion order', () => {
    const ordinary = createTm1Draft02Candidate(candidateInput())
    const reorderedInput = {
      lockingScriptHex: AUTHOR_SCRIPT.toUpperCase(),
      sats: 5_000n,
      sequence: TM1_DRAFT_02_SEQUENCE,
      outIdx: 0,
      txid: TXID_A.toUpperCase()
    }
    const equivalent = createTm1Draft02Candidate(candidateInput({
      authorLockingScriptHex: AUTHOR_SCRIPT.toUpperCase(),
      inputs: [
        reorderedInput,
        {
          lockingScriptHex: AUTHOR_SCRIPT,
          sats: 2_000n,
          sequence: TM1_DRAFT_02_SEQUENCE,
          outIdx: 1,
          txid: TXID_B
        }
      ],
      outputs: [
        { scriptHex: TM1_POST_SCRIPT.toUpperCase(), sats: 0n },
        { scriptHex: AUTHOR_SCRIPT.toUpperCase(), sats: 6_700n }
      ]
    }))

    expect(Array.from(encodeTm1Draft02CandidateEffectiveContent(equivalent))).toEqual(
      Array.from(encodeTm1Draft02CandidateEffectiveContent(ordinary))
    )
  })

  it('changes effective content when a bound transaction field changes', () => {
    const first = createTm1Draft02Candidate(candidateInput())
    const second = createTm1Draft02Candidate(candidateInput({ locktime: 1 }))

    expect(Array.from(encodeTm1Draft02CandidateEffectiveContent(second))).not.toEqual(
      Array.from(encodeTm1Draft02CandidateEffectiveContent(first))
    )
  })

  it('rejects every environment other than the closed deterministic regtest fixture', () => {
    expectCode(
      () => createTm1Draft02Candidate(candidateInput({
        environment: 'ecash:1' as typeof TM1_DRAFT_02_CANDIDATE_ENVIRONMENT
      })),
      'INVALID_ENVIRONMENT'
    )
  })

  it('rejects author indices other than zero and author identity mismatches', () => {
    expectCode(
      () => createTm1Draft02Candidate(candidateInput({ authorInputIndex: 1 })),
      'INVALID_AUTHOR_INPUT_INDEX'
    )
    expectCode(
      () => createTm1Draft02Candidate(candidateInput({
        inputs: [
          {
            txid: TXID_A,
            outIdx: 0,
            sequence: TM1_DRAFT_02_SEQUENCE,
            sats: 5_000n,
            lockingScriptHex: OTHER_SCRIPT
          }
        ],
        outputs: [
          { sats: 0n, scriptHex: TM1_POST_SCRIPT },
          { sats: 4_700n, scriptHex: AUTHOR_SCRIPT }
        ]
      })),
      'AUTHOR_IDENTITY_MISMATCH'
    )
  })

  it('rejects duplicate or tokenized inputs', () => {
    const duplicate = {
      txid: TXID_A,
      outIdx: 0,
      sequence: TM1_DRAFT_02_SEQUENCE,
      sats: 5_000n,
      lockingScriptHex: AUTHOR_SCRIPT
    }
    expectCode(
      () => createTm1Draft02Candidate(candidateInput({ inputs: [duplicate, duplicate] })),
      'DUPLICATE_OUTPOINT'
    )
    expectCode(
      () => createTm1Draft02Candidate(candidateInput({
        inputs: [{ ...duplicate, token: { tokenId: TXID_B } }],
        outputs: [
          { sats: 0n, scriptHex: TM1_POST_SCRIPT },
          { sats: 4_700n, scriptHex: AUTHOR_SCRIPT }
        ]
      })),
      'TOKENIZED_INPUT'
    )
  })

  it('rejects malformed TM1, extra outputs and incorrect change destinations', () => {
    expectCode(
      () => createTm1Draft02Candidate(candidateInput({
        outputs: [
          { sats: 0n, scriptHex: '6a04544d4d00' },
          { sats: 6_700n, scriptHex: AUTHOR_SCRIPT }
        ]
      })),
      'INVALID_TM1_OUTPUT'
    )
    expectCode(
      () => createTm1Draft02Candidate(candidateInput({
        outputs: [
          { sats: 0n, scriptHex: TM1_POST_SCRIPT },
          { sats: 6_700n, scriptHex: AUTHOR_SCRIPT },
          { sats: 1n, scriptHex: AUTHOR_SCRIPT }
        ]
      })),
      'INVALID_OUTPUT_COUNT'
    )
    expectCode(
      () => createTm1Draft02Candidate(candidateInput({
        outputs: [
          { sats: 0n, scriptHex: TM1_POST_SCRIPT },
          { sats: 6_700n, scriptHex: OTHER_SCRIPT }
        ]
      })),
      'INVALID_CHANGE_OUTPUT'
    )
  })

  it('rejects dust change, negative fee, zero fee and fee above the approved limit', () => {
    expectCode(
      () => createTm1Draft02Candidate(candidateInput({
        outputs: [
          { sats: 0n, scriptHex: TM1_POST_SCRIPT },
          { sats: 500n, scriptHex: AUTHOR_SCRIPT }
        ],
        maxFeeSats: 7_000n
      })),
      'DUST_CHANGE'
    )
    expectCode(
      () => createTm1Draft02Candidate(candidateInput({
        outputs: [
          { sats: 0n, scriptHex: TM1_POST_SCRIPT },
          { sats: 7_001n, scriptHex: AUTHOR_SCRIPT }
        ],
        maxFeeSats: 500n
      })),
      'NEGATIVE_FEE'
    )
    expectCode(
      () => createTm1Draft02Candidate(candidateInput({
        outputs: [
          { sats: 0n, scriptHex: TM1_POST_SCRIPT },
          { sats: 7_000n, scriptHex: AUTHOR_SCRIPT }
        ],
        maxFeeSats: 500n
      })),
      'ZERO_FEE'
    )
    expectCode(
      () => createTm1Draft02Candidate(candidateInput({ maxFeeSats: 299n })),
      'FEE_LIMIT_EXCEEDED'
    )
  })

  it('requires the closed ALL_BIP143 policy', () => {
    expectCode(
      () => createTm1Draft02Candidate(candidateInput({
        sighashPolicy: 'SINGLE' as typeof TM1_DRAFT_02_SIGHASH_POLICY
      })),
      'INVALID_SIGHASH_POLICY'
    )
  })
})

describe('TM1 Draft 0.2 pure revalidation', () => {
  it('accepts identical fresh prevouts without depending on their response order', () => {
    const candidate = createTm1Draft02Candidate(candidateInput())
    const fresh = freshUtxos(candidate).reverse()

    expect(() => revalidateTm1Draft02Candidate(candidate, fresh)).not.toThrow()
  })

  it('fails closed for duplicate or missing fresh outpoints', () => {
    const candidate = createTm1Draft02Candidate(candidateInput())
    const fresh = freshUtxos(candidate)

    expectCode(
      () => revalidateTm1Draft02Candidate(candidate, [fresh[0], fresh[0]]),
      'DUPLICATE_FRESH_OUTPOINT'
    )
    expectCode(
      () => revalidateTm1Draft02Candidate(candidate, [fresh[0]]),
      'PREVOUT_MISSING'
    )
  })

  it('fails closed for changed sats, scripts or token state', () => {
    const candidate = createTm1Draft02Candidate(candidateInput())
    const fresh = freshUtxos(candidate)

    expectCode(
      () => revalidateTm1Draft02Candidate(candidate, [
        { ...fresh[0], sats: fresh[0].sats - 1n },
        fresh[1]
      ]),
      'PREVOUT_SATS_MISMATCH'
    )
    expectCode(
      () => revalidateTm1Draft02Candidate(candidate, [
        { ...fresh[0], lockingScriptHex: OTHER_SCRIPT },
        fresh[1]
      ]),
      'PREVOUT_SCRIPT_MISMATCH'
    )
    expectCode(
      () => revalidateTm1Draft02Candidate(candidate, [
        { ...fresh[0], token: { tokenId: TXID_B } },
        fresh[1]
      ]),
      'PREVOUT_TOKENIZED'
    )
  })
})
