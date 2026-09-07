import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Tm1AliasOwnershipTestFetchResponse } from './tm1AliasOwnershipVerificationPort.testFetch'

const currentFetchResponses: Record<string, Tm1AliasOwnershipTestFetchResponse> = {}

// Install global fetch proxy before importing modules that capture fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const rawUrl =
    typeof input === 'string'
      ? new URL(input)
      : input instanceof URL
        ? input
        : new URL(input.url)
  const alias = decodeURIComponent(
    rawUrl.pathname.split('/').filter(Boolean).at(-1) ?? ''
  )
  const spec = currentFetchResponses[alias]
  if (spec === undefined) {
    return new Response('', { status: 404 })
  }
  if (spec.throw !== undefined) {
    throw spec.throw
  }
  if (init?.signal?.aborted) {
    const error = new Error('AbortError')
    error.name = 'AbortError'
    throw error
  }
  const body =
    spec.text !== undefined
      ? spec.text
      : spec.json === undefined
        ? ''
        : JSON.stringify(spec.json)
  return new Response(body, {
    status: spec.status,
    headers: { 'content-type': 'application/json' }
  })
}) as typeof fetch

const {
  DEFAULT_TM1_PROGRAMMATIC_E2E_MESSAGE,
  TM1_PROGRAMMATIC_E2E_FIXTURE_ADDRESS,
  Tm1HarnessApprovalLedger,
  Tm1HarnessOperationLock,
  Tm1HarnessRecoveryStore,
  createDefaultFixtureUtxos,
  createTm1RegtestE2eHarness,
  executeTm1ProgrammaticE2ePipeline
} = await import('./tm1RegtestE2eHarness')

const {
  Tm1AliasOwnershipVerificationError,
  createTm1AliasOwnershipVerificationPort
} = await import('./tm1AliasOwnershipVerificationPort')

const {
  Tm1AliasPublicationAuthorizationError
} = await import('./tm1AliasPublicationAuthorization')

const {
  Tm1PublicationError
} = await import('./tm1RegtestPublicationOrchestrator')

const {
  Tm1PublicationRecoveryStoreError
} = await import('./recovery/tm1PublicationRecoveryStore')

const {
  UniversalAuthorizationError
} = await import('../../features/externalSign/contract')

const {
  parseTm1PublicationRecoveryRecord
} = await import('./recovery/tm1PublicationRecoveryModel')

const TEST_ALIAS = 'satoshi.xec'
const TEST_OWNER = TM1_PROGRAMMATIC_E2E_FIXTURE_ADDRESS
let txidCounter = 10
function nextTxid(): string {
  txidCounter += 1
  return txidCounter.toString(16).padStart(2, '0').repeat(32)
}

function setupMockFetch(alias = TEST_ALIAS, address = TEST_OWNER, txid = nextTxid()): string {
  currentFetchResponses[alias] = {
    status: 200,
    json: {
      alias,
      address,
      txid,
      blockheight: 800_000,
      status: 'confirmed'
    }
  }
  return txid
}

describe('Tm1RegtestE2eHarness — Gate C Programmatic E2E Integration', () => {
  beforeEach(() => {
    for (const key of Object.keys(currentFetchResponses)) {
      delete currentFetchResponses[key]
    }
    setupMockFetch()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('Full End-to-End Pipeline', () => {
    test('executes all 7 steps of the TM1 publication pipeline end-to-end without UI', async () => {
      const result = await executeTm1ProgrammaticE2ePipeline({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        message: 'Gate C programmatic publication test'
      })

      expect(result.success).toBe(true)
      expect(result.alias).toBe(TEST_ALIAS)
      expect(result.ownerAddress).toBe(TEST_OWNER)
      expect(typeof result.txid).toBe('string')
      expect(result.txid).toHaveLength(64)
      expect(typeof result.submissionId).toBe('string')

      const { steps } = result

      // Step 1: Observed simulated alias ownership
      expect(typeof steps.verifiedAliasEvidenceToken).toBe('object')
      expect(steps.verifiedAliasEvidenceToken).not.toBeNull()

      // Step 2: Produced verified ownership snapshot
      expect(steps.verifiedAliasSnapshot.alias).toBe(TEST_ALIAS)
      expect(steps.verifiedAliasSnapshot.address).toBe(TEST_OWNER)
      expect(steps.verifiedAliasSnapshot.txid).toHaveLength(64)
      expect(steps.verifiedAliasSnapshot.blockHeight).toBe(800_000)
      expect(steps.verifiedAliasSnapshot.expiresAt).toBeGreaterThan(Date.now())

      // Step 3: Issued alias publication authorization
      expect(typeof steps.aliasPublicationAuthorization.authorizationId).toBe('string')
      expect(steps.aliasPublicationAuthorization.alias).toBe(TEST_ALIAS)
      expect(steps.aliasPublicationAuthorization.ownerAddress).toBe(TEST_OWNER)

      // Step 4: Prepared canonical memo and unsigned transaction
      expect(steps.memoPreview.protocol).toBe('TM1')
      expect(steps.memoPreview.draft).toBe('0.2')
      expect(steps.candidate.schema).toBe('tonalli.tm1-candidate')
      expect(steps.candidate.authorInputIndex).toBe(0)
      expect(steps.unsignedTransactionBytes).toBeInstanceOf(Uint8Array)
      expect(steps.unsignedTransactionAudit.candidate).toBeDefined()
      expect(steps.preparedReview.preparedId).toBeDefined()
      expect(steps.preparedReview.bindingHash).toHaveLength(64)

      // Step 5: Executed dual authorization & signing
      expect(steps.signingAuthorizationDecision.status).toBe('approved')
      expect(steps.signedReview.txid).toBe(result.txid)
      expect(steps.signedReview.signedArtifact.rawTransactionHex).toBeDefined()
      expect(steps.signedReview.signedArtifact.rawTransactionBytes.length).toBeGreaterThan(0)
      expect(steps.signedReview.signedArtifactHash).toHaveLength(64)

      // Step 6: Recovery reservation and exactly-once dispatch
      expect(steps.witnessReservationSnapshot.pending).toBeDefined()
      expect(steps.dispatchIntentRecord.phase).toBe('outcomeUnknown')
      expect(steps.dispatchIntentRecord.dispatchIntent?.txid).toBe(result.txid)
      expect(steps.dispatchCount).toBe(1)
      expect(steps.submissionReceipt.txid).toBe(result.txid)

      // Step 7: Final success verification
      expect(steps.transportAcknowledgedRecord.phase).toBe('submittedObserved')
      expect(steps.finalOrchestratorState.status).toBe('submitted')
      if (steps.finalOrchestratorState.status === 'submitted') {
        expect(steps.finalOrchestratorState.receipt.txid).toBe(result.txid)
      }
    })
  })

  describe('Granular Step-by-Step Harness Execution', () => {
    test('steps 1-7 can be invoked individually and assert their precise intermediate states', async () => {
      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        message: DEFAULT_TM1_PROGRAMMATIC_E2E_MESSAGE
      })

      // Step 1: Resolve alias & observe ownership
      const evidenceToken = await harness.executeStep1VerifyAlias()
      expect(typeof evidenceToken).toBe('object')

      // Step 2: Produce VerifiedAliasOwnershipEvidence
      const evidenceSnapshot = harness.executeStep2ProduceEvidence(evidenceToken)
      expect(evidenceSnapshot.alias).toBe(TEST_ALIAS)
      expect(evidenceSnapshot.address).toBe(TEST_OWNER)

      // Step 3: Pass verified evidence to authorizer
      const auth = harness.executeStep3AuthorizePublication(evidenceToken)
      expect(auth.alias).toBe(TEST_ALIAS)
      expect(auth.ownerAddress).toBe(TEST_OWNER)

      // Step 4: Prepare canonical TM1 memo & unsigned tx
      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()
      expect(step4.candidate.inputs.length).toBeGreaterThanOrEqual(1)
      expect(step4.candidate.outputs.length).toBe(2)
      expect(step4.preparedReview.bindingHash).toHaveLength(64)

      // Step 5: Execute dual authorization & signing
      const step5 = await harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)
      expect(step5.signingAuthorizationDecision.status).toBe('approved')
      expect(step5.signedReview.preparedId).toBe(step4.preparedReview.preparedId)

      // Step 6: Recovery reservation & dispatch
      const step6 = await harness.executeStep6ReserveRecoveryAndDispatch(
        step4.preparedReview,
        step5.signedReview
      )
      expect(step6.submissionReceipt.txid).toBe(step5.signedReview.txid)
      expect(harness.getDispatchCount()).toBe(1)

      // Step 7: Verify final success
      const step7 = await harness.executeStep7VerifyFinalSuccess(
        step4.preparedReview,
        step5.signedReview,
        step6.submissionReceipt,
        step6.witnessReservationSnapshot
      )
      expect(step7.transportAcknowledgedRecord.phase).toBe('submittedObserved')
      expect(step7.finalOrchestratorState.status).toBe('submitted')
    })
  })

  describe('Adversarial & Rejection Paths', () => {
    test('Step 2: rejects untrusted evidence token not issued by verification port', () => {
      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER
      })

      const fakeToken = Object.freeze({ fake: true })
      expect(() => harness.executeStep2ProduceEvidence(fakeToken)).toThrow(
        Tm1AliasOwnershipVerificationError
      )
    })

    test('Step 2: rejects evidence token if owner address does not match expected', async () => {
      const OTHER_OWNER = 'ecash:qrrd3y2cmg6m2vxlng9h3djh889pmwffhqv9yym2p4'
      setupMockFetch('other.xec', OTHER_OWNER, nextTxid())

      const port = createTm1AliasOwnershipVerificationPort()
      const evidenceToken = await port.verify({
        alias: 'other.xec',
        ownerAddress: OTHER_OWNER
      })

      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        verificationPort: port
      })

      expect(() => harness.executeStep2ProduceEvidence(evidenceToken)).toThrow(
        Tm1AliasOwnershipVerificationError
      )
    })

    test('Step 3: rejects unverified evidence passed to publication authorizer', () => {
      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER
      })

      const fakeToken = Object.freeze({ untrusted: true })
      expect(() => harness.executeStep3AuthorizePublication(fakeToken)).toThrow(
        Tm1AliasPublicationAuthorizationError
      )
    })

    test('Step 5: handles signing authorization rejection from provider', async () => {
      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        signingDecisionProvider: {
          requestDecision: async () => ({
            status: 'rejected',
            reason: 'User declined signing request'
          })
        }
      })

      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()

      await expect(
        harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)
      ).rejects.toThrowError(
        expect.objectContaining({
          code: 'SIGNING_REJECTED'
        })
      )
    })

    test('Step 6: handles broadcast authorization rejection from provider', async () => {
      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        broadcastDecisionProvider: {
          requestDecision: async () => ({
            status: 'rejected',
            reason: 'User cancelled broadcast'
          })
        }
      })

      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()
      const step5 = await harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)

      await expect(
        harness.executeStep6ReserveRecoveryAndDispatch(
          step4.preparedReview,
          step5.signedReview
        )
      ).rejects.toThrowError(
        expect.objectContaining({
          code: 'BROADCAST_REJECTED'
        })
      )
    })

    test('Step 6: enforces exactly-once dispatch (blocks secondary dispatch)', async () => {
      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER
      })

      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()
      const step5 = await harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)
      await harness.executeStep6ReserveRecoveryAndDispatch(
        step4.preparedReview,
        step5.signedReview
      )

      expect(harness.getDispatchCount()).toBe(1)

      // Attempting to broadcast again via the orchestrator must reject with INVALID_STATE
      await expect(
        harness.orchestrator.approveAndBroadcast(step5.signedReview.signedId)
      ).rejects.toThrow(Tm1PublicationError)

      // Transport dispatch counter remains exactly 1
      expect(harness.getDispatchCount()).toBe(1)
    })
  })

  describe('Harness Infrastructure Components', () => {
    test('Tm1HarnessOperationLock prevents concurrent lease acquisition', async () => {
      const lock = new Tm1HarnessOperationLock()
      const controller = new AbortController()

      const lease1 = await lock.acquire('op-1', controller.signal)
      expect(lease1.isOwned()).toBe(true)

      await expect(lock.acquire('op-2', controller.signal)).rejects.toThrow(
        UniversalAuthorizationError
      )

      lease1.release()
      expect(lease1.isOwned()).toBe(false)

      const lease2 = await lock.acquire('op-2', controller.signal)
      expect(lease2.isOwned()).toBe(true)
      lease2.release()
    })

    test('Tm1HarnessApprovalLedger prevents duplicate capability consumption', async () => {
      const ledger = new Tm1HarnessApprovalLedger()
      const controller = new AbortController()

      await ledger.consume(
        {
          capabilityId: 'cap-1',
          operationId: 'op-1',
          contentHash: `sha256:${'11'.repeat(32)}` as `sha256:${string}`,
          expiresAt: Date.now() + 60_000,
          consumedAt: Date.now()
        },
        controller.signal
      )

      await expect(
        ledger.consume(
          {
            capabilityId: 'cap-1',
            operationId: 'op-2',
            contentHash: `sha256:${'11'.repeat(32)}` as `sha256:${string}`,
            expiresAt: Date.now() + 60_000,
            consumedAt: Date.now()
          },
          controller.signal
        )
      ).rejects.toThrow(UniversalAuthorizationError)
    })

    test('Tm1HarnessRecoveryStore enforces CAS revisions and duplicate prevention', async () => {
      const store = new Tm1HarnessRecoveryStore()
      const record = parseTm1PublicationRecoveryRecord({
        schema: 'tonalli.tm1-publication-recovery',
        schemaVersion: 1,
        publicationId: 'pub-test-1',
        revision: 1,
        ownerEpoch: 1,
        phase: 'preDispatch',
        preDispatchStage: 'broadcastAuthorizationConsumed',
        prepared: {
          preparedId: 'prep-1',
          bindingHash: '11'.repeat(32),
          preparedDigest: '11'.repeat(32)
        },
        signed: {
          signedId: 'signed-1',
          txid: '22'.repeat(32),
          signedArtifactHash: '33'.repeat(32)
        },
        signingAuthorization: {
          operationId: 'sign-op-1',
          capabilityId: 'sign-cap-1',
          contentHash: `sha256:${'11'.repeat(32)}` as `sha256:${string}`,
          expiresAt: Date.now() + 60_000,
          consumedAt: Date.now(),
          preparedId: 'prep-1',
          bindingHash: '11'.repeat(32)
        },
        broadcastAuthorization: {
          operationId: 'bcast-op-1',
          capabilityId: 'bcast-cap-1',
          contentHash: `sha256:${'33'.repeat(32)}` as `sha256:${string}`,
          expiresAt: Date.now() + 60_000,
          consumedAt: Date.now(),
          signedId: 'signed-1',
          txid: '22'.repeat(32),
          signedArtifactHash: '33'.repeat(32)
        },
        dispatchIntent: null,
        transportAcknowledgement: null,
        lastObservation: null,
        terminal: null
      })

      await store.create({ record })

      // Duplicate create fails
      await expect(store.create({ record })).rejects.toThrow(
        Tm1PublicationRecoveryStoreError
      )

      // Revision mismatch fails
      await expect(
        store.commitDispatchIntent({
          publicationId: 'pub-test-1',
          expectedRevision: 99,
          expectedOwnerEpoch: 1,
          nextRecord: {
            ...record,
            revision: 100,
            phase: 'outcomeUnknown',
            preDispatchStage: null,
            dispatchIntent: {
              submissionId: 'sub-1',
              txid: '22'.repeat(32),
              signedArtifactHash: '33'.repeat(32),
              broadcastCapabilityId: 'bcast-cap-1',
              committedAt: Date.now()
            }
          }
        })
      ).rejects.toThrow(Tm1PublicationRecoveryStoreError)

      // Stale owner epoch claim fails
      await expect(
        store.claimOwnership({
          publicationId: 'pub-test-1',
          expectedRevision: 1,
          expectedOwnerEpoch: 1,
          nextOwnerEpoch: 1
        })
      ).rejects.toThrow(Tm1PublicationRecoveryStoreError)
    })

    test('createDefaultFixtureUtxos produces valid frozen UTXOs', () => {
      const utxos = createDefaultFixtureUtxos()
      expect(utxos.length).toBe(1)
      expect(utxos[0].sats).toBe(100_000n)
      expect(Object.isFrozen(utxos)).toBe(true)
      expect(Object.isFrozen(utxos[0])).toBe(true)
    })
  })
})
