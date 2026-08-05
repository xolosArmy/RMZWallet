import { describe, expect, test, vi } from 'vitest'
import type { UniversalContentHash } from '../../features/externalSign/contentHash'
import type {
  ApprovalConsumption,
  ApprovalConsumptionLedger
} from '../../features/externalSign/approval'
import { UniversalAuthorizationCore } from '../../features/externalSign/core'
import type {
  UniversalAuthorizationEnvelopeV1
} from '../../features/externalSign/contract'
import type {
  UniversalOperationLease,
  UniversalOperationLock
} from '../../features/externalSign/lock'
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
  type Tm1Draft02Candidate,
  type Tm1Draft02FreshUtxo
} from './tm1Draft02Candidate'
import {
  TM1_DRAFT_02_FIXTURE_AUTHORIZATION_PROFILE_ID,
  Tm1Draft02FixtureAuthorizationAdapter,
  type Tm1Draft02FixtureEffectiveContentSource,
  type Tm1Draft02FixtureSigner,
  type Tm1Draft02FixtureStateProvider
} from './tm1Draft02FixtureAuthorizationAdapter'
import {
  TM1_DRAFT_02_FIXTURE_SIGNED_FORMAT,
  Tm1Draft02FixtureSignedTransactionError,
  auditTm1Draft02FixtureSignedTransaction,
  createTm1Draft02DeterministicFixtureSignedTransaction
} from './tm1Draft02FixtureSignedTransaction'

const AUTHOR_SCRIPT = `76a914${'11'.repeat(20)}88ac`
const AUTHOR_TXID = 'aa'.repeat(32)
const FUNDING_TXID = 'bb'.repeat(32)
const NOW = 1_800_000_000_000

function candidate(): Tm1Draft02Candidate {
  const post = encodeTm1Draft02Post({
    eventData: 'Fixture authorization',
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
    sighashPolicy: TM1_DRAFT_02_SIGHASH_POLICY
  })
}

function freshUtxos(value: Tm1Draft02Candidate): readonly Tm1Draft02FreshUtxo[] {
  return Object.freeze(value.inputs.map(input => Object.freeze({
    txid: input.txid,
    outIdx: input.outIdx,
    sats: input.sats,
    lockingScriptHex: input.lockingScriptHex
  })))
}

function envelope(operationId = 'tm1-fixture-operation'): UniversalAuthorizationEnvelopeV1 {
  return Object.freeze({
    schema: 'tonalli.authorization-envelope',
    version: 1,
    operationId,
    profileId: TM1_DRAFT_02_FIXTURE_AUTHORIZATION_PROFILE_ID,
    issuedAt: NOW - 1,
    expiresAt: NOW + 10_000,
    requester: Object.freeze({
      declaredOrigin: 'https://fixture.invalid',
      displayName: 'TM1 fixture'
    })
  })
}

class FixtureLease implements UniversalOperationLease {
  readonly ownerOperationId: string
  private owned = true

  constructor(ownerOperationId: string) {
    this.ownerOperationId = ownerOperationId
  }

  isOwned(): boolean {
    return this.owned
  }

  release(): void {
    this.owned = false
  }
}

class FixtureLock implements UniversalOperationLock {
  async acquire(operationId: string, signal: AbortSignal): Promise<UniversalOperationLease> {
    if (signal.aborted) throw new Error('OPERATION_ABORTED')
    return new FixtureLease(operationId)
  }
}

class FixtureLedger implements ApprovalConsumptionLedger {
  readonly consumptions: ApprovalConsumption[] = []

  async consume(consumption: ApprovalConsumption, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('OPERATION_ABORTED')
    if (this.consumptions.some(record => record.operationId === consumption.operationId)) {
      throw new Error('APPROVAL_ALREADY_CONSUMED')
    }
    this.consumptions.push(consumption)
  }
}

type HarnessOverrides = Readonly<{
  readFreshUtxos?: Tm1Draft02FixtureStateProvider['readFreshUtxos']
  signFixtureTransaction?: Tm1Draft02FixtureSigner['signFixtureTransaction']
}>

function harness(overrides: HarnessOverrides = {}) {
  const value = candidate()
  const effectiveContent = encodeTm1Draft02CandidateEffectiveContent(value)
  const events: string[] = []
  const source: Tm1Draft02FixtureEffectiveContentSource = {
    readEffectiveContent: vi.fn(async (_envelope, signal) => {
      events.push('prepare')
      if (signal.aborted) throw new Error('OPERATION_ABORTED')
      return new Uint8Array(effectiveContent)
    })
  }
  const stateProvider: Tm1Draft02FixtureStateProvider = {
    readFreshUtxos: vi.fn(overrides.readFreshUtxos ?? (async (_outpoints, signal) => {
      events.push('revalidate')
      if (signal.aborted) throw new Error('OPERATION_ABORTED')
      return freshUtxos(value)
    }))
  }
  const signer: Tm1Draft02FixtureSigner = {
    signFixtureTransaction: vi.fn(overrides.signFixtureTransaction ?? (async input => {
      events.push('sign')
      if (input.signal.aborted) throw new Error('OPERATION_ABORTED')
      return createTm1Draft02DeterministicFixtureSignedTransaction({
        candidate: input.candidate,
        contentHash: input.contentHash
      })
    }))
  }
  const ledger = new FixtureLedger()
  const adapter = new Tm1Draft02FixtureAuthorizationAdapter({
    effectiveContentSource: source,
    stateProvider,
    signer
  })
  const core = new UniversalAuthorizationCore({
    enabled: true,
    lock: new FixtureLock(),
    approvalLedger: {
      consume: async (consumption, signal) => {
        events.push('consume')
        await ledger.consume(consumption, signal)
      }
    },
    now: () => NOW,
    createCapabilityId: operationId => `${operationId}:fixture-capability`
  })
  return Object.freeze({
    value,
    effectiveContent,
    events,
    source,
    stateProvider,
    signer,
    ledger,
    adapter,
    core
  })
}

describe('TM1 Draft 0.2 fixture authorization adapter', () => {
  test('prepares a deterministic review from canonical effectiveContent', async () => {
    const testHarness = harness()
    const review = await testHarness.adapter.prepareReview(
      envelope(),
      new AbortController().signal
    )

    expect(review.effectiveContent).toEqual(testHarness.effectiveContent)
    expect(review.fields).toContainEqual({ label: 'Environment', value: 'deterministic-regtest-fixture' })
    expect(review.fields).toContainEqual({ label: 'Author input', value: '0' })
    expect(review.fields).toContainEqual({ label: 'Fee sats', value: '1000' })
    expect(review.fields).toContainEqual({ label: 'Delivery', value: 'fixture-only; no broadcast' })
  })

  test('runs prepare, revalidate, consumes capability, and signs exactly once through the real core', async () => {
    const testHarness = harness()
    const operation = testHarness.core.start(envelope(), testHarness.adapter)
    const prepared = await operation.ready
    const result = await operation.approve()

    expect(prepared.review.effectiveContent).toEqual(testHarness.effectiveContent)
    expect(result.format).toBe(TM1_DRAFT_02_FIXTURE_SIGNED_FORMAT)
    expect(result.contentHash).toBe(prepared.contentHash)
    expect(testHarness.events).toEqual(['prepare', 'revalidate', 'consume', 'sign'])
    expect(testHarness.ledger.consumptions).toHaveLength(1)
    expect(testHarness.signer.signFixtureTransaction).toHaveBeenCalledTimes(1)
    expect(operation.state()).toBe('completed')
    expect(operation.history()).toEqual([
      'disabled',
      'receiving',
      'preparing',
      'reviewReady',
      'approving',
      'revalidating',
      'signing',
      'completed'
    ])

    const audited = auditTm1Draft02FixtureSignedTransaction({
      candidate: testHarness.value,
      contentHash: result.contentHash,
      signedTransactionBytes: result.bytes
    })
    expect(audited.feeSats).toBe(1_000n)
  })

  test('does not sign or consume when fresh prevout sats changed', async () => {
    const testHarness = harness({
      readFreshUtxos: async (_outpoints, _signal) => {
        const fresh = [...freshUtxos(candidate())]
        fresh[0] = Object.freeze({ ...fresh[0]!, sats: 6_999n })
        return fresh
      }
    })
    const operation = testHarness.core.start(envelope(), testHarness.adapter)
    await operation.ready

    await expect(operation.approve()).rejects.toThrow('PREVOUT_SATS_MISMATCH')
    expect(testHarness.ledger.consumptions).toHaveLength(0)
    expect(testHarness.signer.signFixtureTransaction).not.toHaveBeenCalled()
    expect(operation.state()).toBe('failed')
  })

  test('rejects signed bytes changed after the injected signer returns', async () => {
    const testHarness = harness({
      signFixtureTransaction: async input => {
        const bytes = createTm1Draft02DeterministicFixtureSignedTransaction({
          candidate: input.candidate,
          contentHash: input.contentHash
        })
        const altered = new Uint8Array(bytes)
        altered[altered.length - 5] ^= 1
        return altered
      }
    })
    const operation = testHarness.core.start(envelope(), testHarness.adapter)
    await operation.ready

    await expect(operation.approve()).rejects.toBeInstanceOf(
      Tm1Draft02FixtureSignedTransactionError
    )
    expect(testHarness.ledger.consumptions).toHaveLength(1)
    expect(testHarness.signer.signFixtureTransaction).toHaveBeenCalledTimes(1)
    expect(operation.state()).toBe('failed')
  })

  test('binds deterministic fixture attestations to contentHash', () => {
    const value = candidate()
    const firstHash = `sha256:${'11'.repeat(32)}` as UniversalContentHash
    const secondHash = `sha256:${'22'.repeat(32)}` as UniversalContentHash
    const bytes = createTm1Draft02DeterministicFixtureSignedTransaction({
      candidate: value,
      contentHash: firstHash
    })

    expect(() => auditTm1Draft02FixtureSignedTransaction({
      candidate: value,
      contentHash: secondHash,
      signedTransactionBytes: bytes
    })).toThrowError(Tm1Draft02FixtureSignedTransactionError)
  })

  test('refuses a second approval after the operation completed', async () => {
    const testHarness = harness()
    const operation = testHarness.core.start(envelope('tm1-one-use'), testHarness.adapter)
    await operation.ready
    await operation.approve()

    await expect(operation.approve()).rejects.toThrow('INVALID_STATE_TRANSITION')
    expect(testHarness.ledger.consumptions).toHaveLength(1)
    expect(testHarness.signer.signFixtureTransaction).toHaveBeenCalledTimes(1)
  })
})
