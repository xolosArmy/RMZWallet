import { Tx } from 'ecash-lib'
import { describe, expect, test } from 'vitest'
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
  TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX,
  TM1_REGTEST_SIGNED_TRANSACTION_FORMAT,
  Tm1Draft02RegtestSignerError,
  signTm1Draft02RegtestCandidate
} from './tm1Draft02RegtestP2pkhSigner'

const AUTHOR_TXID = 'aa'.repeat(32)
const FUNDING_TXID = 'bb'.repeat(32)
const OTHER_SCRIPT = `76a914${'22'.repeat(20)}88ac`

function candidate(overrides: Partial<Parameters<typeof createTm1Draft02Candidate>[0]> = {}): Tm1Draft02Candidate {
  const post = encodeTm1Draft02Post({
    eventData: 'Regtest signer fixture',
    authorInputIndex: TM1_DRAFT_02_AUTHOR_INPUT_INDEX
  })
  return createTm1Draft02Candidate({
    environment: TM1_DRAFT_02_CANDIDATE_ENVIRONMENT,
    transactionVersion: TM1_DRAFT_02_TX_VERSION,
    locktime: TM1_DRAFT_02_LOCKTIME,
    authorInputIndex: TM1_DRAFT_02_AUTHOR_INPUT_INDEX,
    authorLockingScriptHex: TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX,
    inputs: [
      {
        txid: AUTHOR_TXID,
        outIdx: 0,
        sequence: TM1_DRAFT_02_SEQUENCE,
        sats: 7_000n,
        lockingScriptHex: TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX
      },
      {
        txid: FUNDING_TXID,
        outIdx: 1,
        sequence: TM1_DRAFT_02_SEQUENCE,
        sats: 4_000n,
        lockingScriptHex: TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX
      }
    ],
    outputs: [
      { sats: 0n, scriptHex: post.scriptHex },
      { sats: 10_000n, scriptHex: TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX }
    ],
    dustSats: 546n,
    maxFeeSats: 2_000n,
    sighashPolicy: TM1_DRAFT_02_SIGHASH_POLICY,
    ...overrides
  })
}

function expectSignerCode(action: () => unknown, code: string): void {
  try {
    action()
    throw new Error('Expected signer to throw')
  } catch (error) {
    expect(error).toBeInstanceOf(Tm1Draft02RegtestSignerError)
    expect((error as Tm1Draft02RegtestSignerError).code).toBe(code)
  }
}

describe('TM1 Draft 0.2 isolated regtest P2PKH signer', () => {
  test('creates deterministic node-valid P2PKH transaction bytes and txid', () => {
    const value = candidate()
    const first = signTm1Draft02RegtestCandidate({ candidate: value })
    const second = signTm1Draft02RegtestCandidate({ candidate: value })
    const parsed = Tx.fromHex(first.rawTransactionHex)

    expect(first.format).toBe(TM1_REGTEST_SIGNED_TRANSACTION_FORMAT)
    expect(first.environment).toBe(TM1_DRAFT_02_CANDIDATE_ENVIRONMENT)
    expect(first.sighashPolicy).toBe(TM1_DRAFT_02_SIGHASH_POLICY)
    expect(first.inputCount).toBe(2)
    expect(first.feeSats).toBe(1_000n)
    expect(first.txid).toBe(parsed.txid())
    expect(first.rawTransactionBytes).toEqual(parsed.ser())
    expect(first.rawTransactionHex).toBe(second.rawTransactionHex)
    expect(first.txid).toBe(second.txid)
    expect(parsed.inputs.every(input => (input.script?.bytecode.length ?? 0) > 0)).toBe(true)
    expect(parsed.outputs[0]?.script.toHex()).toBe(value.outputs[0].scriptHex)
    expect(parsed.outputs[1]?.script.toHex()).toBe(TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX)
  })

  test('rejects any funding input not controlled by the public fixture key', () => {
    const value = candidate({
      inputs: [
        {
          txid: AUTHOR_TXID,
          outIdx: 0,
          sequence: TM1_DRAFT_02_SEQUENCE,
          sats: 7_000n,
          lockingScriptHex: TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX
        },
        {
          txid: FUNDING_TXID,
          outIdx: 1,
          sequence: TM1_DRAFT_02_SEQUENCE,
          sats: 4_000n,
          lockingScriptHex: OTHER_SCRIPT
        }
      ]
    })

    expectSignerCode(
      () => signTm1Draft02RegtestCandidate({ candidate: value }),
      'INPUT_NOT_OWNED_BY_FIXTURE_KEY'
    )
  })

  test('fails closed for forged non-fixture environments and author indices', () => {
    const value = candidate()
    const forgedEnvironment = {
      ...value,
      environment: 'mainnet'
    } as unknown as Tm1Draft02Candidate
    const forgedAuthorIndex = {
      ...value,
      authorInputIndex: 1
    } as unknown as Tm1Draft02Candidate

    expect(() => signTm1Draft02RegtestCandidate({ candidate: forgedEnvironment })).toThrow()
    expect(() => signTm1Draft02RegtestCandidate({ candidate: forgedAuthorIndex })).toThrow()
  })

  test('respects an already-aborted AbortSignal before any signing work', () => {
    const controller = new AbortController()
    controller.abort()

    expectSignerCode(
      () => signTm1Draft02RegtestCandidate({ candidate: candidate(), signal: controller.signal }),
      'OPERATION_ABORTED'
    )
  })
})
