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
  assertWitnessReservationResponseBinding,
  assertWitnessEnrollmentBinding,
  assertWitnessFinalizationBinding,
  assertPersistedWitnessBinding,
  assertTm1CommittedDispatchIntentBinding,
  computeCanonicalWholeStoreRoot,
  compareStringsCodeUnit,
  deepEqual,
  deriveStoreSlotId,
  isStoreNonEmpty,
  assertStoreConsistentWithWitnessStableHead,
  extractStoreId,
  createDefaultFixtureUtxos,
  createTm1RegtestE2eHarness,
  canonicalizeHarnessAlias,
  canonicalizeHarnessOwnerAddress,
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
import type { Tm1PublicationRecoveryRecord } from './recovery/tm1PublicationRecoveryModel'

const {
  parseTm1RollbackWitnessSnapshot
} = await import('./recovery/tm1RollbackWitness')

const {
  Tm1InMemoryRollbackWitness
} = await import('./recovery/tm1InMemoryRollbackWitness')

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

    test('Step 6: rejects signedReview with mismatched preparedId (SIGNED_REVIEW_MISMATCH)', async () => {
      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER
      })

      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()
      const step5 = await harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)

      const mismatchedSignedReview = {
        ...step5.signedReview,
        preparedId: 'mismatched-prep-id'
      }

      await expect(
        harness.executeStep6ReserveRecoveryAndDispatch(
          step4.preparedReview,
          mismatchedSignedReview
        )
      ).rejects.toThrow(/SIGNED_REVIEW_MISMATCH: preparedId mismatch/)

      expect(harness.getDispatchCount()).toBe(0)
    })

    test('Step 6: rejects signedReview with mismatched bindingHash (SIGNED_REVIEW_MISMATCH)', async () => {
      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER
      })

      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()
      const step5 = await harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)

      const mismatchedSignedReview = {
        ...step5.signedReview,
        bindingHash: '00'.repeat(32)
      }

      await expect(
        harness.executeStep6ReserveRecoveryAndDispatch(
          step4.preparedReview,
          mismatchedSignedReview
        )
      ).rejects.toThrow(/SIGNED_REVIEW_MISMATCH: bindingHash mismatch/)

      expect(harness.getDispatchCount()).toBe(0)
    })

    test('Step 6: rejects signedReview with mismatched signedArtifactHash (SIGNED_REVIEW_MISMATCH) (Finding 1)', async () => {
      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER
      })

      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()
      const step5 = await harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)

      const mismatchedSignedReview = {
        ...step5.signedReview,
        signedArtifactHash: '11'.repeat(32)
      }

      await expect(
        harness.executeStep6ReserveRecoveryAndDispatch(
          step4.preparedReview,
          mismatchedSignedReview
        )
      ).rejects.toThrow(/SIGNED_REVIEW_MISMATCH: signedArtifactHash mismatch/)

      expect(harness.getDispatchCount()).toBe(0)
    })

    test('Step 6: rejects signedReview with tampered fields not matching orchestrator internal review (Finding 1)', async () => {
      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER
      })

      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()
      const step5 = await harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)

      const tamperedSignedReview = {
        ...step5.signedReview,
        signedId: 'tampered-signed-id'
      }

      await expect(
        harness.executeStep6ReserveRecoveryAndDispatch(
          step4.preparedReview,
          tamperedSignedReview
        )
      ).rejects.toThrow(/SIGNED_REVIEW_MISMATCH: Provided signedReview does not match orchestrator internal signedReview/)

      expect(harness.getDispatchCount()).toBe(0)
    })

    test('Step 6: rejects preparedReview with mismatched preparedId (PREPARED_REVIEW_MISMATCH) (Finding 1)', async () => {
      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER
      })

      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()
      const step5 = await harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)

      const mismatchedPreparedReview = {
        ...step4.preparedReview,
        preparedId: 'prepared-e2e-different-id'
      }

      await expect(
        harness.executeStep6ReserveRecoveryAndDispatch(
          mismatchedPreparedReview,
          step5.signedReview
        )
      ).rejects.toThrow(/PREPARED_REVIEW_MISMATCH/)

      expect(harness.getDispatchCount()).toBe(0)
    })

    test('Step 6: rejects preparedReview with mismatched bindingHash (PREPARED_REVIEW_MISMATCH) (Finding 1)', async () => {
      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER
      })

      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()
      const step5 = await harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)

      const mismatchedPreparedReview = {
        ...step4.preparedReview,
        bindingHash: '00'.repeat(32)
      }

      await expect(
        harness.executeStep6ReserveRecoveryAndDispatch(
          mismatchedPreparedReview,
          step5.signedReview
        )
      ).rejects.toThrow(/PREPARED_REVIEW_MISMATCH: bindingHash mismatch/)

      expect(harness.getDispatchCount()).toBe(0)
    })

    test('Step 6: rejects preparedReview with tampered fields not matching orchestrator internal review (PREPARED_REVIEW_MISMATCH) (Finding 1)', async () => {
      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER
      })

      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()
      const step5 = await harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)

      const tamperedPreparedReview = {
        ...step4.preparedReview,
        message: 'tampered memo content'
      }

      await expect(
        harness.executeStep6ReserveRecoveryAndDispatch(
          tamperedPreparedReview,
          step5.signedReview
        )
      ).rejects.toThrow(/PREPARED_REVIEW_MISMATCH: Provided preparedReview does not match orchestrator internal preparedReview/)

      expect(harness.getDispatchCount()).toBe(0)
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

    test('Step 6: rejects when witness enroll returns mismatched snapshot (WITNESS_ENROLLMENT_BINDING_MISMATCH)', async () => {
      const realWitness = new Tm1InMemoryRollbackWitness()
      const byzantineWitness = {
        read: (req: any) => realWitness.read(req),
        enroll: async (req: any) => {
          const snapshot = parseTm1RollbackWitnessSnapshot(await realWitness.enroll(req))
          return {
            ...snapshot,
            stable: {
              ...snapshot.stable,
              operationId: 'byzantine-wrong-op'
            }
          }
        },
        reserve: (req: any) => realWitness.reserve(req),
        finalize: (req: any) => realWitness.finalize(req),
        verifyRecord: async () => true
      }

      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        witness: byzantineWitness as any
      })

      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()
      const step5 = await harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)

      await expect(
        harness.executeStep6ReserveRecoveryAndDispatch(
          step4.preparedReview,
          step5.signedReview
        )
      ).rejects.toThrow(/WITNESS_ENROLLMENT_BINDING_MISMATCH.*operationId mismatch/)

      expect(harness.getDispatchCount()).toBe(0)
    })

    test('Step 6: rejects when witness enroll returns non-genesis snapshot with non-null previousStableReceiptHash (Finding 2)', async () => {
      const realWitness = new Tm1InMemoryRollbackWitness()
      const byzantineWitness = {
        read: (req: any) => realWitness.read(req),
        enroll: async (req: any) => {
          const snapshot = parseTm1RollbackWitnessSnapshot(await realWitness.enroll(req))
          return {
            ...snapshot,
            stable: {
              ...snapshot.stable,
              generation: 1,
              previousStableReceiptHash: '99'.repeat(32)
            }
          }
        },
        reserve: (req: any) => realWitness.reserve(req),
        finalize: (req: any) => realWitness.finalize(req),
        verifyRecord: async () => true
      }

      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        witness: byzantineWitness as any
      })

      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()
      const step5 = await harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)

      await expect(
        harness.executeStep6ReserveRecoveryAndDispatch(
          step4.preparedReview,
          step5.signedReview
        )
      ).rejects.toThrow(/WITNESS_ENROLLMENT_BINDING_MISMATCH: previousStableReceiptHash mismatch/)

      expect(harness.getDispatchCount()).toBe(0)
    })

    test('Step 6: rejects when recovery store enrollWitnessBinding returns invalid/corrupted binding (Finding 3)', async () => {
      const realStore = new Tm1HarnessRecoveryStore()
      const byzantineStore = {
        storeId: realStore.getStoreId(),
        getStoreId: () => realStore.getStoreId(),
        listRecoverable: () => realStore.listRecoverable(),
        create: (input: any) => realStore.create(input),
        commitExecutionEvidence: (input: any) => realStore.commitExecutionEvidence(input),
        commitDispatchIntent: (input: any) => realStore.commitDispatchIntent(input),
        load: (pubId: string) => realStore.load(pubId),
        commitTransportAcknowledgement: (input: any) => realStore.commitTransportAcknowledgement(input),
        commitRecoveryTransition: (input: any) => realStore.commitRecoveryTransition(input),
        claimOwnership: (input: any) => realStore.claimOwnership(input),
        computeEnrollmentLogicalRoot: (id: any) => realStore.computeEnrollmentLogicalRoot(id),
        enrollWitnessBinding: () => ({
          slotId: 'slot:corrupted',
          storeId: realStore.getStoreId(),
          generation: 0,
          logicalRoot: '00'.repeat(32)
        }),
        inspectWitnessBinding: () => null
      }

      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        recoveryStore: byzantineStore as any
      })

      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()
      const step5 = await harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)

      await expect(
        harness.executeStep6ReserveRecoveryAndDispatch(
          step4.preparedReview,
          step5.signedReview
        )
      ).rejects.toThrow(/PERSISTED_ENROLLMENT_BINDING_MISMATCH: slotId mismatch/)

      expect(harness.getDispatchCount()).toBe(0)
    })

    test('Step 6: rejects when recovery store fails to persist witness enrollment binding or inspectWitnessBinding diverges (Finding 3)', async () => {
      const realStore = new Tm1HarnessRecoveryStore()
      const byzantineStore = {
        storeId: realStore.getStoreId(),
        getStoreId: () => realStore.getStoreId(),
        listRecoverable: () => realStore.listRecoverable(),
        create: (input: any) => realStore.create(input),
        commitExecutionEvidence: (input: any) => realStore.commitExecutionEvidence(input),
        commitDispatchIntent: (input: any) => realStore.commitDispatchIntent(input),
        load: (pubId: string) => realStore.load(pubId),
        commitTransportAcknowledgement: (input: any) => realStore.commitTransportAcknowledgement(input),
        commitRecoveryTransition: (input: any) => realStore.commitRecoveryTransition(input),
        claimOwnership: (input: any) => realStore.claimOwnership(input),
        computeEnrollmentLogicalRoot: (id: any) => realStore.computeEnrollmentLogicalRoot(id),
        enrollWitnessBinding: (binding: any) => {
          realStore.enrollWitnessBinding(binding)
          return { ...binding, generation: 0 }
        },
        inspectWitnessBinding: () => null // Persistence failure: DB didn't save or returned null
      }

      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        recoveryStore: byzantineStore as any
      })

      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()
      const step5 = await harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)

      await expect(
        harness.executeStep6ReserveRecoveryAndDispatch(
          step4.preparedReview,
          step5.signedReview
        )
      ).rejects.toThrow(/PERSISTED_ENROLLMENT_BINDING_MISMATCH: Expected valid binding object, got object/)

      expect(harness.getDispatchCount()).toBe(0)
    })

    test('Step 6: rejects when recovery store returns success but fails durable persistence (false positive)', async () => {
      const realStore = new Tm1HarnessRecoveryStore()
      const byzantineStore = {
        storeId: realStore.getStoreId(),
        getStoreId: () => realStore.getStoreId(),
        listRecoverable: () => realStore.listRecoverable(),
        create: (input: any) => realStore.create(input),
        commitExecutionEvidence: (input: any) => realStore.commitExecutionEvidence(input),
        commitDispatchIntent: async (input: any) => {
          const res = await realStore.commitDispatchIntent(input)
          // Byzantine false positive: record is not persisted in durable storage
          ;(realStore as any).records.delete(input.publicationId)
          return res
        },
        load: (pubId: string) => realStore.load(pubId),
        commitTransportAcknowledgement: (input: any) => realStore.commitTransportAcknowledgement(input),
        commitRecoveryTransition: (input: any) => realStore.commitRecoveryTransition(input),
        claimOwnership: (input: any) => realStore.claimOwnership(input)
      }

      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        recoveryStore: byzantineStore as any
      })

      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()
      const step5 = await harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)

      await expect(
        harness.executeStep6ReserveRecoveryAndDispatch(
          step4.preparedReview,
          step5.signedReview
        )
      ).rejects.toThrow(/DURABLE_STORE_PERSISTENCE_MISMATCH/)

      expect(harness.getDispatchCount()).toBe(0)
    })

    test('Step 6: rejects when durable store root diverges from reserved root before finalization', async () => {
      const realStore = new Tm1HarnessRecoveryStore()
      const byzantineStore = {
        storeId: realStore.getStoreId(),
        getStoreId: () => realStore.getStoreId(),
        listRecoverable: () => realStore.listRecoverable(),
        create: (input: any) => realStore.create(input),
        commitExecutionEvidence: (input: any) => realStore.commitExecutionEvidence(input),
        commitDispatchIntent: async (input: any) => {
          const res = await realStore.commitDispatchIntent(input)
          const rec = (realStore as any).records.get(input.publicationId)
          if (rec) {
            ;(realStore as any).records.set(input.publicationId, {
              ...rec,
              ownerEpoch: 999
            })
          }
          return res
        },
        load: (pubId: string) => realStore.load(pubId),
        commitTransportAcknowledgement: (input: any) => realStore.commitTransportAcknowledgement(input),
        commitRecoveryTransition: (input: any) => realStore.commitRecoveryTransition(input),
        claimOwnership: (input: any) => realStore.claimOwnership(input)
      }

      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        recoveryStore: byzantineStore as any
      })

      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()
      const step5 = await harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)

      await expect(
        harness.executeStep6ReserveRecoveryAndDispatch(
          step4.preparedReview,
          step5.signedReview
        )
      ).rejects.toThrow(/DURABLE_STORE_PERSISTENCE_MISMATCH/)

      expect(harness.getDispatchCount()).toBe(0)
    })

    test('Step 6: rejects when witness finalize returns forked previousStableReceiptHash', async () => {
      const realWitness = new Tm1InMemoryRollbackWitness()
      const byzantineWitness = {
        read: (req: any) => realWitness.read(req),
        enroll: (req: any) => realWitness.enroll(req),
        reserve: (req: any) => realWitness.reserve(req),
        finalize: async (req: any) => {
          const snapshot = parseTm1RollbackWitnessSnapshot(await realWitness.finalize(req))
          return {
            ...snapshot,
            stable: {
              ...snapshot.stable,
              previousStableReceiptHash: 'ff'.repeat(32)
            }
          }
        },
        verifyRecord: async () => true
      }

      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        witness: byzantineWitness as any
      })

      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()
      const step5 = await harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)

      await expect(
        harness.executeStep6ReserveRecoveryAndDispatch(
          step4.preparedReview,
          step5.signedReview
        )
      ).rejects.toThrow(/WITNESS_FINALIZATION_MISMATCH.*previousStableReceiptHash mismatch/)

      expect(harness.getDispatchCount()).toBe(0)
    })

    test('Step 6: rejects when witness finalize returns mismatched witnessKeyId', async () => {
      const realWitness = new Tm1InMemoryRollbackWitness()
      const byzantineWitness = {
        read: (req: any) => realWitness.read(req),
        enroll: (req: any) => realWitness.enroll(req),
        reserve: (req: any) => realWitness.reserve(req),
        finalize: async (req: any) => {
          const snapshot = parseTm1RollbackWitnessSnapshot(await realWitness.finalize(req))
          return {
            ...snapshot,
            stable: {
              ...snapshot.stable,
              witnessKeyId: 'wk-byzantine-unauthorized'
            }
          }
        },
        verifyRecord: async () => true
      }

      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        witness: byzantineWitness as any
      })

      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()
      const step5 = await harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)

      await expect(
        harness.executeStep6ReserveRecoveryAndDispatch(
          step4.preparedReview,
          step5.signedReview
        )
      ).rejects.toThrow(/WITNESS_FINALIZATION_MISMATCH.*witnessKeyId mismatch/)

      expect(harness.getDispatchCount()).toBe(0)
    })

    test('Step 7: rejects when witness finalize returns forked previousStableReceiptHash in acknowledgement', async () => {
      const realWitness = new Tm1InMemoryRollbackWitness()
      let finalizeCount = 0
      const byzantineWitness = {
        read: (req: any) => realWitness.read(req),
        enroll: (req: any) => realWitness.enroll(req),
        reserve: (req: any) => realWitness.reserve(req),
        finalize: async (req: any) => {
          finalizeCount++
          const snapshot = parseTm1RollbackWitnessSnapshot(await realWitness.finalize(req))
          if (finalizeCount === 2) {
            return {
              ...snapshot,
              stable: {
                ...snapshot.stable,
                previousStableReceiptHash: 'ee'.repeat(32)
              }
            }
          }
          return snapshot
        },
        verifyRecord: async () => true
      }

      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        witness: byzantineWitness as any
      })

      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()
      const step5 = await harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)
      const step6 = await harness.executeStep6ReserveRecoveryAndDispatch(
        step4.preparedReview,
        step5.signedReview
      )

      await expect(
        harness.executeStep7VerifyFinalSuccess(
          step4.preparedReview,
          step5.signedReview,
          step6.submissionReceipt
        )
      ).rejects.toThrow(/WITNESS_FINALIZATION_MISMATCH.*previousStableReceiptHash mismatch/)
    })

    test('Step 7: rejects when recovery store returns altered acknowledgedAt timestamp in acknowledgement', async () => {
      const realStore = new Tm1HarnessRecoveryStore()
      const byzantineStore = {
        storeId: realStore.getStoreId(),
        getStoreId: () => realStore.getStoreId(),
        listRecoverable: () => realStore.listRecoverable(),
        create: (input: any) => realStore.create(input),
        commitExecutionEvidence: (input: any) => realStore.commitExecutionEvidence(input),
        commitDispatchIntent: (input: any) => realStore.commitDispatchIntent(input),
        load: (pubId: string) => realStore.load(pubId),
        commitTransportAcknowledgement: async (input: any) => {
          const res: any = await realStore.commitTransportAcknowledgement(input)
          return {
            ...res,
            transportAcknowledgement: {
              ...res.transportAcknowledgement,
              acknowledgedAt: res.transportAcknowledgement.acknowledgedAt + 99999
            }
          }
        },
        commitRecoveryTransition: (input: any) => realStore.commitRecoveryTransition(input),
        claimOwnership: (input: any) => realStore.claimOwnership(input)
      }

      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        recoveryStore: byzantineStore as any
      })

      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()
      const step5 = await harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)
      const step6 = await harness.executeStep6ReserveRecoveryAndDispatch(
        step4.preparedReview,
        step5.signedReview
      )

      await expect(
        harness.executeStep7VerifyFinalSuccess(
          step4.preparedReview,
          step5.signedReview,
          step6.submissionReceipt
        )
      ).rejects.toThrow(/INVALID_ACKNOWLEDGEMENT_RECORD.*acknowledgedAt mismatch/)
    })

    test('Step 7: rejects when durable store persistence fails after acknowledgement commit', async () => {
      const realStore = new Tm1HarnessRecoveryStore()
      const byzantineStore = {
        storeId: realStore.getStoreId(),
        getStoreId: () => realStore.getStoreId(),
        listRecoverable: () => realStore.listRecoverable(),
        create: (input: any) => realStore.create(input),
        commitExecutionEvidence: (input: any) => realStore.commitExecutionEvidence(input),
        commitDispatchIntent: (input: any) => realStore.commitDispatchIntent(input),
        load: (pubId: string) => realStore.load(pubId),
        commitTransportAcknowledgement: async (input: any) => {
          const res = await realStore.commitTransportAcknowledgement(input)
          // Byzantine failure to persist: delete record from durable storage
          ;(realStore as any).records.delete(input.publicationId)
          return res
        },
        commitRecoveryTransition: (input: any) => realStore.commitRecoveryTransition(input),
        claimOwnership: (input: any) => realStore.claimOwnership(input)
      }

      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        recoveryStore: byzantineStore as any
      })

      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()
      const step5 = await harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)
      const step6 = await harness.executeStep6ReserveRecoveryAndDispatch(
        step4.preparedReview,
        step5.signedReview
      )

      await expect(
        harness.executeStep7VerifyFinalSuccess(
          step4.preparedReview,
          step5.signedReview,
          step6.submissionReceipt
        )
      ).rejects.toThrow(/DURABLE_STORE_PERSISTENCE_MISMATCH/)
    })

    test('Step 4: rejects preparation when verified owner address does not match author locking script', async () => {
      const OTHER_OWNER = 'ecash:qrrd3y2cmg6m2vxlng9h3djh889pmwffhqv9yym2p4'
      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER
      })

      await expect(
        harness.executeStep4PrepareMemoAndUnsignedTx(OTHER_OWNER)
      ).rejects.toThrow(/AUTHOR_OWNER_BINDING_MISMATCH/)
    })

    test('Pipeline: rejects if verified alias owner does not match author locking script', async () => {
      const OTHER_OWNER = 'ecash:qrrd3y2cmg6m2vxlng9h3djh889pmwffhqv9yym2p4'
      setupMockFetch('other.xec', OTHER_OWNER, nextTxid())

      const harness = createTm1RegtestE2eHarness({
        alias: 'other.xec',
        ownerAddress: OTHER_OWNER
      })

      await expect(harness.executePipeline()).rejects.toThrow(/AUTHOR_OWNER_BINDING_MISMATCH/)
    })

    test('Step 6: persists actual consumed grants into recovery store and leaves store empty on broadcast rejection', async () => {
      // 1. Broadcast rejection: no recovery record is committed
      const rejectingHarness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        broadcastDecisionProvider: {
          requestDecision: async () => ({
            status: 'rejected',
            reason: 'Broadcast authorization rejected'
          })
        }
      })
      const rStep4 = await rejectingHarness.executeStep4PrepareMemoAndUnsignedTx()
      const rStep5 = await rejectingHarness.executeStep5DualAuthorizeAndSign(rStep4.preparedReview)
      await expect(
        rejectingHarness.executeStep6ReserveRecoveryAndDispatch(
          rStep4.preparedReview,
          rStep5.signedReview
        )
      ).rejects.toThrowError(
        expect.objectContaining({
          code: 'BROADCAST_REJECTED'
        })
      )
      const publicationId = `pub:${rStep4.preparedReview.preparedId}`
      expect(await rejectingHarness.recoveryStore.load(publicationId)).toBeNull()

      // 2. Success path: recovery store contains actual consumed grants from ledger
      const successHarness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER
      })
      const sStep4 = await successHarness.executeStep4PrepareMemoAndUnsignedTx()
      const sStep5 = await successHarness.executeStep5DualAuthorizeAndSign(sStep4.preparedReview)
      await successHarness.executeStep6ReserveRecoveryAndDispatch(
        sStep4.preparedReview,
        sStep5.signedReview
      )

      const stored = (await successHarness.recoveryStore.load(
        `pub:${sStep4.preparedReview.preparedId}`
      )) as Tm1PublicationRecoveryRecord | null
      expect(stored).not.toBeNull()

      // Check signing authorization grant binding
      expect(stored?.signingAuthorization?.capabilityId).toBe(
        sStep5.signedReview.signingAuthorizationId
      )
      const signingConsumption = successHarness.ledger.getConsumption(
        sStep5.signedReview.signingAuthorizationId
      )
      expect(signingConsumption).toBeDefined()
      expect(stored?.signingAuthorization?.operationId).toBe(signingConsumption?.operationId)
      expect(stored?.signingAuthorization?.consumedAt).toBe(signingConsumption?.consumedAt)

      // Check broadcast authorization grant binding
      const broadcastCapId = stored?.broadcastAuthorization?.capabilityId
      expect(broadcastCapId).toBeDefined()
      const broadcastConsumption = successHarness.ledger.getConsumption(broadcastCapId!)
      expect(broadcastConsumption).toBeDefined()
      expect(stored?.broadcastAuthorization?.operationId).toBe(broadcastConsumption?.operationId)
      expect(stored?.broadcastAuthorization?.consumedAt).toBe(broadcastConsumption?.consumedAt)
    })

    test('Step 6: rejects unauthenticated witness snapshot during reservation', async () => {
      const realWitness = new Tm1InMemoryRollbackWitness()
      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        witness: {
          read: (args) => realWitness.read(args),
          enroll: (args) => realWitness.enroll(args),
          reserve: (args) => realWitness.reserve(args),
          finalize: (args) => realWitness.finalize(args),
          verifyRecord: async () => false // Simulation of unauthenticated / forged witness record
        }
      })

      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()
      const step5 = await harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)

      await expect(
        harness.executeStep6ReserveRecoveryAndDispatch(
          step4.preparedReview,
          step5.signedReview
        )
      ).rejects.toThrow(/UNAUTHENTICATED_WITNESS/)
    })

    test('Step 7: validates acknowledgement before finalizing witness (rejects forged/tampered acknowledgement)', async () => {
      let finalizeCalled = false
      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER
      })

      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()
      const step5 = await harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)
      const step6 = await harness.executeStep6ReserveRecoveryAndDispatch(
        step4.preparedReview,
        step5.signedReview
      )

      // Spy on witness finalize to guarantee it is NOT called when acknowledgement is forged
      const originalFinalize = harness.witness.finalize.bind(harness.witness)
      harness.witness.finalize = async (args) => {
        finalizeCalled = true
        return originalFinalize(args)
      }

      // Intercept recoveryStore.commitTransportAcknowledgement to return a record with mismatched publicationId
      const originalCommitAck =
        harness.recoveryStore.commitTransportAcknowledgement.bind(harness.recoveryStore)
      harness.recoveryStore.commitTransportAcknowledgement = async (args) => {
        const authenticRecord = (await originalCommitAck(args)) as Tm1PublicationRecoveryRecord
        // Tamper with record: inject mismatched publicationId
        return {
          ...authenticRecord,
          publicationId: 'pub:forged-publication-id-999'
        }
      }

      await expect(
        harness.executeStep7VerifyFinalSuccess(
          step4.preparedReview,
          step5.signedReview,
          step6.submissionReceipt,
          step6.witnessReservationSnapshot
        )
      ).rejects.toThrow(/INVALID_ACKNOWLEDGEMENT_RECORD/)

      // Witness finalization MUST NOT have been called
      expect(finalizeCalled).toBe(false)
    })

    test('Step 7: rejects malformed recovery record and aborts before witness finalization', async () => {
      let finalizeCalled = false
      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER
      })

      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()
      const step5 = await harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)
      const step6 = await harness.executeStep6ReserveRecoveryAndDispatch(
        step4.preparedReview,
        step5.signedReview
      )

      // Spy on witness finalize
      const originalFinalize = harness.witness.finalize.bind(harness.witness)
      harness.witness.finalize = async (args) => {
        finalizeCalled = true
        return originalFinalize(args)
      }

      // Intercept recoveryStore.commitTransportAcknowledgement to return a completely malformed object
      harness.recoveryStore.commitTransportAcknowledgement = async () => ({
        untrusted: true,
        forged: 'malformed-payload'
      })

      await expect(
        harness.executeStep7VerifyFinalSuccess(
          step4.preparedReview,
          step5.signedReview,
          step6.submissionReceipt,
          step6.witnessReservationSnapshot
        )
      ).rejects.toThrow(/MALFORMED_RECOVERY_RECORD/)

      // Witness finalization MUST NOT have been called
      expect(finalizeCalled).toBe(false)
    })

    test('Step 6: rejects witness reservation response if pending record is not bound to request parameters (Finding 2)', async () => {
      const realWitness = new Tm1InMemoryRollbackWitness()
      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        witness: {
          read: (args) => realWitness.read(args),
          enroll: (args) => realWitness.enroll(args),
          reserve: async (args) => {
            const authentic = parseTm1RollbackWitnessSnapshot(await realWitness.reserve(args))
            // Tamper with reservation snapshot: modify pending logicalRoot
            return {
              ...authentic,
              pending: {
                ...authentic.pending!,
                logicalRoot: 'ff'.repeat(32)
              }
            }
          },
          finalize: (args) => realWitness.finalize(args),
          // Simulation: witness signatures pass verification, but returned parameters are mismatched
          verifyRecord: async () => true
        }
      })

      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()
      const step5 = await harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)

      await expect(
        harness.executeStep6ReserveRecoveryAndDispatch(
          step4.preparedReview,
          step5.signedReview
        )
      ).rejects.toThrow(/WITNESS_RESERVATION_BINDING_MISMATCH/)
      expect(harness.getDispatchCount()).toBe(0)
    })

    test('Step 6: rejects witness reservation response if stable head does not match last read (Finding 2)', async () => {
      const realWitness = new Tm1InMemoryRollbackWitness()
      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        witness: {
          read: (args) => realWitness.read(args),
          enroll: (args) => realWitness.enroll(args),
          reserve: async (args) => {
            const authentic = parseTm1RollbackWitnessSnapshot(await realWitness.reserve(args))
            const otherStoreId = `tm1-store:v1:${'99'.repeat(32)}`
            // Tamper with reservation snapshot: modify stable and pending storeId to mismatch last read
            return {
              stable: {
                ...authentic.stable,
                storeId: otherStoreId
              },
              pending: {
                ...authentic.pending!,
                storeId: otherStoreId
              }
            }
          },
          finalize: (args) => realWitness.finalize(args),
          // Simulation: witness signatures pass verification, but returned stable head is mismatched
          verifyRecord: async () => true
        }
      })

      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()
      const step5 = await harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)

      await expect(
        harness.executeStep6ReserveRecoveryAndDispatch(
          step4.preparedReview,
          step5.signedReview
        )
      ).rejects.toThrow(/WITNESS_RESERVATION_BINDING_MISMATCH/)
      expect(harness.getDispatchCount()).toBe(0)
    })

    test('Step 6: validates returned intent from commitDispatchIntent and blocks broadcast if tampered (Finding 3)', async () => {
      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER
      })

      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()
      const step5 = await harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)

      // Tamper commitDispatchIntent to return invalid record (tampered revision)
      const originalCommit =
        harness.recoveryStore.commitDispatchIntent.bind(harness.recoveryStore)
      harness.recoveryStore.commitDispatchIntent = async (args) => {
        const authentic = (await originalCommit(args)) as Tm1PublicationRecoveryRecord
        return {
          ...authentic,
          revision: 999
        }
      }

      await expect(
        harness.executeStep6ReserveRecoveryAndDispatch(
          step4.preparedReview,
          step5.signedReview
        )
      ).rejects.toThrow(/INVALID_DISPATCH_INTENT_RECORD/)

      expect(harness.getDispatchCount()).toBe(0)
    })

    test('Step 6: validates returned intent from commitDispatchIntent rejects malformed payload and blocks broadcast (Finding 3)', async () => {
      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER
      })

      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()
      const step5 = await harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)

      // Tamper commitDispatchIntent to return unparseable record
      harness.recoveryStore.commitDispatchIntent = async () => 'not-a-valid-record'

      await expect(
        harness.executeStep6ReserveRecoveryAndDispatch(
          step4.preparedReview,
          step5.signedReview
        )
      ).rejects.toThrow(/INVALID_DISPATCH_INTENT_RECORD/)

      expect(harness.getDispatchCount()).toBe(0)
    })

    test('Step 6: finalizes dispatch intent checkpoint BEFORE broadcast and blocks broadcast if finalization fails (Finding 4)', async () => {
      const realWitness = new Tm1InMemoryRollbackWitness()
      let finalizeInvocationCount = 0

      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        witness: {
          read: (args) => realWitness.read(args),
          enroll: (args) => realWitness.enroll(args),
          reserve: (args) => realWitness.reserve(args),
          finalize: async () => {
            finalizeInvocationCount += 1
            // Simulate witness outage or refusal during dispatch intent finalization
            throw new Error('WITNESS_UNAVAILABLE_DURING_FINALIZE')
          },
          verifyRecord: (args) => realWitness.verifyRecord(args)
        }
      })

      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()
      const step5 = await harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)

      await expect(
        harness.executeStep6ReserveRecoveryAndDispatch(
          step4.preparedReview,
          step5.signedReview
        )
      ).rejects.toThrow('WITNESS_UNAVAILABLE_DURING_FINALIZE')

      expect(finalizeInvocationCount).toBe(1)
      expect(harness.getDispatchCount()).toBe(0)
    })

    test('Full double checkpoint flow: dispatch intent checkpoint (gen 1) before broadcast, acknowledgement checkpoint (gen 2) after broadcast with dynamic canonical roots (Findings 1 & 4)', async () => {
      const recordedCheckpoints: Array<{
        action: string
        generation: number
        logicalRoot: string
      }> = []
      const realWitness = new Tm1InMemoryRollbackWitness()

      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        witness: {
          read: (args) => realWitness.read(args),
          enroll: async (args) => {
            recordedCheckpoints.push({
              action: 'enroll',
              generation: 0,
              logicalRoot: args.logicalRoot
            })
            return realWitness.enroll(args)
          },
          reserve: async (args) => {
            recordedCheckpoints.push({
              action: 'reserve',
              generation: args.nextGeneration,
              logicalRoot: args.nextLogicalRoot
            })
            return realWitness.reserve(args)
          },
          finalize: async (args) => {
            recordedCheckpoints.push({
              action: 'finalize',
              generation: args.generation,
              logicalRoot: args.logicalRoot
            })
            return realWitness.finalize(args)
          },
          verifyRecord: (args) => realWitness.verifyRecord(args)
        }
      })

      const result = await harness.executePipeline()
      expect(result.success).toBe(true)

      // Verify sequence of witness operations:
      // 1. enroll generation 0
      // 2. reserve generation 1 (dispatch intent)
      // 3. finalize generation 1 (dispatch intent) -> BEFORE broadcast
      // 4. reserve generation 2 (acknowledgement)
      // 5. finalize generation 2 (acknowledgement)
      expect(recordedCheckpoints).toHaveLength(5)
      expect(recordedCheckpoints[0]).toMatchObject({ action: 'enroll', generation: 0 })
      expect(recordedCheckpoints[1]).toMatchObject({ action: 'reserve', generation: 1 })
      expect(recordedCheckpoints[2]).toMatchObject({ action: 'finalize', generation: 1 })
      expect(recordedCheckpoints[3]).toMatchObject({ action: 'reserve', generation: 2 })
      expect(recordedCheckpoints[4]).toMatchObject({ action: 'finalize', generation: 2 })

      // Verify roots are dynamically computed (64-char sha256 hex, NOT hardcoded 00... or 01...)
      expect(recordedCheckpoints[0].logicalRoot).not.toBe('00'.repeat(32))
      expect(recordedCheckpoints[0].logicalRoot).not.toBe('01'.repeat(32))
      expect(recordedCheckpoints[1].logicalRoot).not.toBe('00'.repeat(32))
      expect(recordedCheckpoints[1].logicalRoot).not.toBe('01'.repeat(32))
      expect(recordedCheckpoints[0].logicalRoot).toHaveLength(64)
      expect(recordedCheckpoints[1].logicalRoot).toHaveLength(64)
      expect(recordedCheckpoints[3].logicalRoot).toHaveLength(64)

      // Generation 1 root must match finalized dispatch intent root
      expect(recordedCheckpoints[1].logicalRoot).toBe(recordedCheckpoints[2].logicalRoot)
      // Generation 2 root must match finalized acknowledgement root
      expect(recordedCheckpoints[3].logicalRoot).toBe(recordedCheckpoints[4].logicalRoot)
      // Generation 1 and 2 roots must differ because store transitioned
      expect(recordedCheckpoints[1].logicalRoot).not.toBe(
        recordedCheckpoints[3].logicalRoot
      )

      // Verify step results contain both snapshots
      expect(result.steps.witnessReservationSnapshot.pending?.generation).toBe(1)
      expect(result.steps.witnessFinalizedDispatchSnapshot?.stable.generation).toBe(1)
      expect(result.steps.witnessAcknowledgementSnapshot?.stable.generation).toBe(2)
      expect(result.steps.witnessAcknowledgementSnapshot?.pending).toBeNull()
    })

    test('Dynamic root calculation and storeId extraction handle custom store and canonical identity (Finding 1)', async () => {
      const customStoreId = `tm1-store:v1:${'77'.repeat(32)}`
      const store = new Tm1HarnessRecoveryStore(customStoreId)
      expect(extractStoreId(store)).toBe(customStoreId)
      const emptyCanonicalRoot = computeCanonicalWholeStoreRoot({
        storeId: customStoreId,
        slotId: 'slot:test',
        generation: 0,
        records: [],
        capabilityIds: []
      })
      expect(emptyCanonicalRoot).toMatch(/^[0-9a-f]{64}$/)

      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        recoveryStore: store
      })
      expect(harness.getStoreId()).toBe(customStoreId)

      const rootGen0 = await harness.deriveStoreRoot({
        slotId: 'slot:test',
        generation: 0,
        storeId: customStoreId
      })
      expect(rootGen0).toMatch(/^[0-9a-f]{64}$/)
      expect(rootGen0).not.toBe('00'.repeat(32))
      expect(rootGen0).not.toBe('01'.repeat(32))
    })

    test('computeCanonicalWholeStoreRoot: root ordering is deterministic and ignores localeCompare (Finding 4)', () => {
      const storeId = `tm1-store:v1:${'11'.repeat(32)}`
      const slotId = 'slot:test'

      const recordA = parseTm1PublicationRecoveryRecord({
        schema: 'tonalli.tm1-publication-recovery',
        schemaVersion: 1,
        publicationId: 'pub:Alpha',
        revision: 1,
        ownerEpoch: 1,
        phase: 'preDispatch',
        preDispatchStage: 'broadcastAuthorizationConsumed',
        prepared: {
          preparedId: 'prep:seed1',
          bindingHash: '11'.repeat(32),
          preparedDigest: '11'.repeat(32)
        },
        signed: {
          signedId: 'signed:seed1',
          txid: '22'.repeat(32),
          signedArtifactHash: '33'.repeat(32)
        },
        signingAuthorization: {
          operationId: 'op:s',
          capabilityId: 'cap:s',
          contentHash: `sha256:${'11'.repeat(32)}` as const,
          expiresAt: 1000,
          consumedAt: 500,
          preparedId: 'prep:seed1',
          bindingHash: '11'.repeat(32)
        },
        broadcastAuthorization: {
          operationId: 'op:b',
          capabilityId: 'cap:b',
          contentHash: `sha256:${'22'.repeat(32)}` as const,
          expiresAt: 1000,
          consumedAt: 500,
          signedId: 'signed:seed1',
          txid: '22'.repeat(32),
          signedArtifactHash: '33'.repeat(32)
        },
        dispatchIntent: null,
        transportAcknowledgement: null,
        lastObservation: null,
        terminal: null
      })

      const recordB = parseTm1PublicationRecoveryRecord({
        ...recordA,
        publicationId: 'pub:alpha'
      })

      // Root calculated in order [recordA, recordB]
      const root1 = computeCanonicalWholeStoreRoot({
        storeId,
        slotId,
        generation: 0,
        records: [recordA, recordB],
        capabilityIds: ['cap:b', 'cap:Beta']
      })

      // Root calculated in reverse order [recordB, recordA] must be identical
      const root2 = computeCanonicalWholeStoreRoot({
        storeId,
        slotId,
        generation: 0,
        records: [recordB, recordA],
        capabilityIds: ['cap:Beta', 'cap:b']
      })

      expect(root1).toBe(root2)

      // Verify that localeCompare is never invoked during computeCanonicalWholeStoreRoot
      const originalLocaleCompare = String.prototype.localeCompare
      let localeCompareCalled = false
      try {
        String.prototype.localeCompare = function () {
          localeCompareCalled = true
          throw new Error('localeCompare should never be called in canonical root computation!')
        }
        const rootNoLocale = computeCanonicalWholeStoreRoot({
          storeId,
          slotId,
          generation: 0,
          records: [recordB, recordA],
          capabilityIds: ['cap:Beta', 'cap:b']
        })
        expect(rootNoLocale).toBe(root1)
        expect(localeCompareCalled).toBe(false)
      } finally {
        String.prototype.localeCompare = originalLocaleCompare
      }
    })

    test('Direct assertion helper test: assertWitnessReservationResponseBinding checks all mismatch cases', () => {
      const mockStable = {
        protocol: 'tonalli.tm1-rollback-witness' as const,
        protocolVersion: 1 as const,
        slotId: 'slot:1',
        storeId: `tm1-store:v1:${'11'.repeat(32)}`,
        generation: 0,
        logicalRoot: '00'.repeat(32),
        receiptHash: 'aa'.repeat(32),
        witnessKeyId: 'wk-1',
        state: 'stable' as const,
        operationId: 'op:0',
        previousStableReceiptHash: null,
        authenticatedReceipt: 'auth-0'
      }
      const mockReq = {
        slotId: 'slot:1',
        storeId: `tm1-store:v1:${'11'.repeat(32)}`,
        expectedStableGeneration: 0,
        expectedStableLogicalRoot: '00'.repeat(32),
        expectedStableReceiptHash: 'aa'.repeat(32),
        nextGeneration: 1,
        nextLogicalRoot: '11'.repeat(32),
        operationId: 'op:1'
      }
      const validPending = {
        protocol: 'tonalli.tm1-rollback-witness' as const,
        protocolVersion: 1 as const,
        slotId: 'slot:1',
        storeId: `tm1-store:v1:${'11'.repeat(32)}`,
        generation: 1,
        logicalRoot: '11'.repeat(32),
        receiptHash: 'bb'.repeat(32),
        witnessKeyId: 'wk-1',
        state: 'pending' as const,
        operationId: 'op:1',
        previousStableReceiptHash: 'aa'.repeat(32),
        authenticatedReceipt: 'auth-1'
      }

      // Valid snapshot passes
      expect(() => {
        assertWitnessReservationResponseBinding(
          { stable: mockStable, pending: validPending },
          mockReq,
          mockStable
        )
      }).not.toThrow()

      // Missing pending
      expect(() => {
        assertWitnessReservationResponseBinding(
          { stable: mockStable, pending: null },
          mockReq,
          mockStable
        )
      }).toThrow(/WITNESS_RESERVATION_MISSING_PENDING/)

      // Mismatched pending generation
      expect(() => {
        assertWitnessReservationResponseBinding(
          { stable: mockStable, pending: { ...validPending, generation: 2 } },
          mockReq,
          mockStable
        )
      }).toThrow(/WITNESS_RESERVATION_BINDING_MISMATCH/)

      // Mismatched pending root
      expect(() => {
        assertWitnessReservationResponseBinding(
          {
            stable: mockStable,
            pending: { ...validPending, logicalRoot: '22'.repeat(32) }
          },
          mockReq,
          mockStable
        )
      }).toThrow(/WITNESS_RESERVATION_BINDING_MISMATCH/)

      // Mismatched pending operationId
      expect(() => {
        assertWitnessReservationResponseBinding(
          { stable: mockStable, pending: { ...validPending, operationId: 'op:wrong' } },
          mockReq,
          mockStable
        )
      }).toThrow(/WITNESS_RESERVATION_BINDING_MISMATCH/)

      // Mismatched pending previousStableReceiptHash
      expect(() => {
        assertWitnessReservationResponseBinding(
          {
            stable: mockStable,
            pending: { ...validPending, previousStableReceiptHash: 'ff'.repeat(32) }
          },
          mockReq,
          mockStable
        )
      }).toThrow(/WITNESS_RESERVATION_BINDING_MISMATCH/)
    })

    test('Direct assertion helper test: assertWitnessFinalizationBinding checks all mismatch cases', () => {
      const pendingRecord = {
        protocol: 'tonalli.tm1-rollback-witness' as const,
        protocolVersion: 1 as const,
        slotId: 'slot:1',
        storeId: `tm1-store:v1:${'11'.repeat(32)}`,
        generation: 1,
        logicalRoot: '11'.repeat(32),
        receiptHash: 'bb'.repeat(32),
        witnessKeyId: 'wk-1',
        state: 'pending' as const,
        operationId: 'op:1',
        previousStableReceiptHash: 'aa'.repeat(32),
        authenticatedReceipt: 'auth-1'
      }

      const validFinalizedStable = {
        protocol: 'tonalli.tm1-rollback-witness' as const,
        protocolVersion: 1 as const,
        slotId: 'slot:1',
        storeId: `tm1-store:v1:${'11'.repeat(32)}`,
        generation: 1,
        logicalRoot: '11'.repeat(32),
        receiptHash: 'cc'.repeat(32),
        witnessKeyId: 'wk-1',
        state: 'stable' as const,
        operationId: 'op:1',
        previousStableReceiptHash: 'aa'.repeat(32),
        authenticatedReceipt: 'auth-final'
      }

      // Valid pass
      expect(() => {
        assertWitnessFinalizationBinding(
          { stable: validFinalizedStable, pending: null },
          pendingRecord
        )
      }).not.toThrow()

      // Non-null pending
      expect(() => {
        assertWitnessFinalizationBinding(
          { stable: validFinalizedStable, pending: pendingRecord },
          pendingRecord
        )
      }).toThrow(/WITNESS_FINALIZATION_MISMATCH: Finalized snapshot must have null pending record/)

      // SlotId mismatch
      expect(() => {
        assertWitnessFinalizationBinding(
          { stable: { ...validFinalizedStable, slotId: 'slot:diff' }, pending: null },
          pendingRecord
        )
      }).toThrow(/WITNESS_FINALIZATION_MISMATCH: slotId mismatch/)

      // StoreId mismatch
      expect(() => {
        assertWitnessFinalizationBinding(
          { stable: { ...validFinalizedStable, storeId: 'tm1-store:v1:diff' }, pending: null },
          pendingRecord
        )
      }).toThrow(/WITNESS_FINALIZATION_MISMATCH: storeId mismatch/)

      // Generation mismatch
      expect(() => {
        assertWitnessFinalizationBinding(
          { stable: { ...validFinalizedStable, generation: 2 }, pending: null },
          pendingRecord
        )
      }).toThrow(/WITNESS_FINALIZATION_MISMATCH: generation mismatch/)

      // LogicalRoot mismatch
      expect(() => {
        assertWitnessFinalizationBinding(
          { stable: { ...validFinalizedStable, logicalRoot: '99'.repeat(32) }, pending: null },
          pendingRecord
        )
      }).toThrow(/WITNESS_FINALIZATION_MISMATCH: logicalRoot mismatch/)

      // OperationId mismatch
      expect(() => {
        assertWitnessFinalizationBinding(
          { stable: { ...validFinalizedStable, operationId: 'op:diff' }, pending: null },
          pendingRecord
        )
      }).toThrow(/WITNESS_FINALIZATION_MISMATCH: operationId mismatch/)

      // PreviousStableReceiptHash mismatch (receipt chain fork)
      expect(() => {
        assertWitnessFinalizationBinding(
          {
            stable: {
              ...validFinalizedStable,
              previousStableReceiptHash: 'ff'.repeat(32)
            },
            pending: null
          },
          pendingRecord
        )
      }).toThrow(/WITNESS_FINALIZATION_MISMATCH: previousStableReceiptHash mismatch/)

      // WitnessKeyId mismatch
      expect(() => {
        assertWitnessFinalizationBinding(
          { stable: { ...validFinalizedStable, witnessKeyId: 'wk-diff' }, pending: null },
          pendingRecord
        )
      }).toThrow(/WITNESS_FINALIZATION_MISMATCH: witnessKeyId mismatch/)
    })

    test('Direct assertion helper test: assertWitnessEnrollmentBinding checks all mismatch cases', () => {
      const mockReq = {
        slotId: 'slot:test',
        storeId: `tm1-store:v1:${'11'.repeat(32)}`,
        logicalRoot: '00'.repeat(32),
        operationId: 'enroll:slot:test'
      }

      const validStable = {
        protocol: 'tonalli.tm1-rollback-witness' as const,
        protocolVersion: 1 as const,
        slotId: mockReq.slotId,
        storeId: mockReq.storeId,
        generation: 0,
        logicalRoot: mockReq.logicalRoot,
        receiptHash: 'aa'.repeat(32),
        witnessKeyId: 'wk-1',
        state: 'stable' as const,
        operationId: mockReq.operationId,
        previousStableReceiptHash: null,
        authenticatedReceipt: 'auth-0'
      }

      // Valid pass
      expect(() => {
        assertWitnessEnrollmentBinding(
          { stable: validStable, pending: null },
          mockReq
        )
      }).not.toThrow()

      // Non-null pending
      expect(() => {
        assertWitnessEnrollmentBinding(
          {
            stable: validStable,
            pending: { ...validStable, state: 'pending' as const }
          },
          mockReq
        )
      }).toThrow(/WITNESS_ENROLLMENT_BINDING_MISMATCH: Enrolled snapshot must have null pending record/)

      // Generation mismatch
      expect(() => {
        assertWitnessEnrollmentBinding(
          { stable: { ...validStable, generation: 1 }, pending: null },
          mockReq
        )
      }).toThrow(/WITNESS_ENROLLMENT_BINDING_MISMATCH: generation mismatch/)

      // SlotId mismatch
      expect(() => {
        assertWitnessEnrollmentBinding(
          { stable: { ...validStable, slotId: 'slot:diff' }, pending: null },
          mockReq
        )
      }).toThrow(/WITNESS_ENROLLMENT_BINDING_MISMATCH: slotId mismatch/)

      // StoreId mismatch
      expect(() => {
        assertWitnessEnrollmentBinding(
          { stable: { ...validStable, storeId: 'tm1-store:v1:diff' }, pending: null },
          mockReq
        )
      }).toThrow(/WITNESS_ENROLLMENT_BINDING_MISMATCH: storeId mismatch/)

      // LogicalRoot mismatch
      expect(() => {
        assertWitnessEnrollmentBinding(
          { stable: { ...validStable, logicalRoot: 'ff'.repeat(32) }, pending: null },
          mockReq
        )
      }).toThrow(/WITNESS_ENROLLMENT_BINDING_MISMATCH: logicalRoot mismatch/)

      // OperationId mismatch
      expect(() => {
        assertWitnessEnrollmentBinding(
          { stable: { ...validStable, operationId: 'wrong:op' }, pending: null },
          mockReq
        )
      }).toThrow(/WITNESS_ENROLLMENT_BINDING_MISMATCH: operationId mismatch/)

      // Non-null previousStableReceiptHash (Finding 2)
      expect(() => {
        assertWitnessEnrollmentBinding(
          {
            stable: { ...validStable, previousStableReceiptHash: '88'.repeat(32) },
            pending: null
          },
          mockReq
        )
      }).toThrow(/WITNESS_ENROLLMENT_BINDING_MISMATCH: previousStableReceiptHash mismatch/)
    })

    test('Direct assertion helper test: assertPersistedWitnessBinding checks all mismatch cases (Finding 3)', () => {
      const expected = {
        slotId: 'slot:test',
        storeId: `tm1-store:v1:${'11'.repeat(32)}`,
        logicalRoot: '00'.repeat(32),
        generation: 0
      }
      const valid = { ...expected }

      // Valid pass
      expect(() => {
        assertPersistedWitnessBinding(valid, expected)
      }).not.toThrow()

      // Null or primitive binding
      expect(() => {
        assertPersistedWitnessBinding(null, expected)
      }).toThrow(/PERSISTED_ENROLLMENT_BINDING_MISMATCH: Expected valid binding object, got object/)
      expect(() => {
        assertPersistedWitnessBinding(undefined, expected)
      }).toThrow(/PERSISTED_ENROLLMENT_BINDING_MISMATCH: Expected valid binding object, got undefined/)

      // SlotId mismatch
      expect(() => {
        assertPersistedWitnessBinding({ ...valid, slotId: 'slot:diff' }, expected)
      }).toThrow(/PERSISTED_ENROLLMENT_BINDING_MISMATCH: slotId mismatch/)

      // StoreId mismatch
      expect(() => {
        assertPersistedWitnessBinding({ ...valid, storeId: 'store:diff' }, expected)
      }).toThrow(/PERSISTED_ENROLLMENT_BINDING_MISMATCH: storeId mismatch/)

      // LogicalRoot mismatch
      expect(() => {
        assertPersistedWitnessBinding({ ...valid, logicalRoot: 'ff'.repeat(32) }, expected)
      }).toThrow(/PERSISTED_ENROLLMENT_BINDING_MISMATCH: logicalRoot mismatch/)

      // Generation mismatch
      expect(() => {
        assertPersistedWitnessBinding({ ...valid, generation: 1 }, expected)
      }).toThrow(/PERSISTED_ENROLLMENT_BINDING_MISMATCH: generation mismatch/)
    })

    test('Direct comparator test: compareStringsCodeUnit enforces deterministic code-unit ordering (Finding 4)', () => {
      expect(compareStringsCodeUnit('a', 'b')).toBe(-1)
      expect(compareStringsCodeUnit('b', 'a')).toBe(1)
      expect(compareStringsCodeUnit('a', 'a')).toBe(0)
      // Uppercase ASCII code units vs lowercase
      expect(compareStringsCodeUnit('A', 'a')).toBe(-1)
      expect(compareStringsCodeUnit('a', 'A')).toBe(1)
      // Numeric code units
      expect(compareStringsCodeUnit('10', '2')).toBe(-1)
      expect(compareStringsCodeUnit('2', '10')).toBe(1)
    })

    test('Direct assertion helper test: assertTm1CommittedDispatchIntentBinding checks mismatch cases', () => {
      const mockRecord: Tm1PublicationRecoveryRecord = {
        schema: 'tonalli.tm1-publication-recovery',
        schemaVersion: 1,
        publicationId: 'pub:1',
        revision: 2,
        ownerEpoch: 1,
        phase: 'outcomeUnknown',
        preDispatchStage: null,
        prepared: {
          preparedId: 'prep:1',
          bindingHash: 'bh-1',
          preparedDigest: 'bh-1'
        },
        signed: {
          signedId: 'signed:1',
          txid: 'tx-1',
          signedArtifactHash: 'hash-1'
        },
        signingAuthorization: {
          operationId: 'op:sign',
          capabilityId: 'cap:sign',
          contentHash: `sha256:${'aa'.repeat(32)}` as const,
          expiresAt: 1000,
          consumedAt: 500,
          preparedId: 'prep:1',
          bindingHash: 'bh-1'
        },
        broadcastAuthorization: {
          operationId: 'op:bcast',
          capabilityId: 'cap:bcast',
          contentHash: `sha256:${'bb'.repeat(32)}` as const,
          expiresAt: 1000,
          consumedAt: 500,
          signedId: 'signed:1',
          txid: 'tx-1',
          signedArtifactHash: 'hash-1'
        },
        dispatchIntent: {
          submissionId: 'sub:1',
          txid: 'tx-1',
          signedArtifactHash: 'hash-1',
          broadcastCapabilityId: 'cap:bcast',
          committedAt: 600
        },
        transportAcknowledgement: null,
        lastObservation: null,
        terminal: null
      }

      const input = {
        committedRecord: mockRecord,
        publicationId: 'pub:1',
        expectedRevision: 2,
        expectedOwnerEpoch: 1,
        preparedReview: {
          preparedId: 'prep:1',
          bindingHash: 'bh-1',
          preparedDigest: 'bh-1'
        } as any,
        signedReview: {
          signedId: 'signed:1',
          txid: 'tx-1',
          signedArtifactHash: 'hash-1',
          preparedId: 'prep:1',
          signingAuthorizationId: 'auth:sign'
        } as any,
        signingGrant: {
          operationId: 'op:sign',
          capabilityId: 'cap:sign',
          contentHash: `sha256:${'aa'.repeat(32)}` as const,
          expiresAt: 1000,
          consumedAt: 500
        } as any,
        broadcastGrant: {
          operationId: 'op:bcast',
          capabilityId: 'cap:bcast',
          contentHash: `sha256:${'bb'.repeat(32)}` as const,
          expiresAt: 1000,
          consumedAt: 500
        } as any,
        submissionId: 'sub:1'
      }

      // Valid passes
      expect(() => {
        assertTm1CommittedDispatchIntentBinding(input)
      }).not.toThrow()

      // deepEqual helper works correctly
      expect(deepEqual(mockRecord, mockRecord)).toBe(true)
      expect(deepEqual({ a: 1, b: 'x' }, { a: 1, b: 'x' })).toBe(true)
      expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false)
      expect(deepEqual({ a: 1 }, { b: 1 })).toBe(false)
      expect(deepEqual(null, null)).toBe(true)
      expect(deepEqual(null, {})).toBe(false)

      // Valid passes with expectedCommittedAt and expectedRecord
      expect(() => {
        assertTm1CommittedDispatchIntentBinding({
          ...input,
          expectedCommittedAt: 600,
          expectedRecord: mockRecord
        })
      }).not.toThrow()

      // Wrong phase
      expect(() => {
        assertTm1CommittedDispatchIntentBinding({
          ...input,
          committedRecord: { ...mockRecord, phase: 'preDispatch' }
        })
      }).toThrow(/INVALID_DISPATCH_INTENT_RECORD/)

      // Wrong revision
      expect(() => {
        assertTm1CommittedDispatchIntentBinding({
          ...input,
          committedRecord: { ...mockRecord, revision: 3 }
        })
      }).toThrow(/INVALID_DISPATCH_INTENT_RECORD/)

      // Missing dispatch intent
      expect(() => {
        assertTm1CommittedDispatchIntentBinding({
          ...input,
          committedRecord: { ...mockRecord, dispatchIntent: null }
        })
      }).toThrow(/INVALID_DISPATCH_INTENT_RECORD/)

      // Mismatched submissionId
      expect(() => {
        assertTm1CommittedDispatchIntentBinding({
          ...input,
          submissionId: 'sub:wrong'
        })
      }).toThrow(/INVALID_DISPATCH_INTENT_RECORD/)

      // Mismatched signingAuthorization contentHash
      expect(() => {
        assertTm1CommittedDispatchIntentBinding({
          ...input,
          committedRecord: {
            ...mockRecord,
            signingAuthorization: {
              ...mockRecord.signingAuthorization!,
              contentHash: `sha256:${'cc'.repeat(32)}` as any
            }
          }
        })
      }).toThrow(/INVALID_DISPATCH_INTENT_RECORD/)

      // Mismatched signingAuthorization expiresAt
      expect(() => {
        assertTm1CommittedDispatchIntentBinding({
          ...input,
          committedRecord: {
            ...mockRecord,
            signingAuthorization: {
              ...mockRecord.signingAuthorization!,
              expiresAt: 9999
            }
          }
        })
      }).toThrow(/INVALID_DISPATCH_INTENT_RECORD/)

      // Mismatched signingAuthorization consumedAt
      expect(() => {
        assertTm1CommittedDispatchIntentBinding({
          ...input,
          committedRecord: {
            ...mockRecord,
            signingAuthorization: {
              ...mockRecord.signingAuthorization!,
              consumedAt: 9999
            }
          }
        })
      }).toThrow(/INVALID_DISPATCH_INTENT_RECORD/)

      // Mismatched broadcastAuthorization contentHash
      expect(() => {
        assertTm1CommittedDispatchIntentBinding({
          ...input,
          committedRecord: {
            ...mockRecord,
            broadcastAuthorization: {
              ...mockRecord.broadcastAuthorization!,
              contentHash: `sha256:${'dd'.repeat(32)}` as any
            }
          }
        })
      }).toThrow(/INVALID_DISPATCH_INTENT_RECORD/)

      // Mismatched broadcastAuthorization expiresAt
      expect(() => {
        assertTm1CommittedDispatchIntentBinding({
          ...input,
          committedRecord: {
            ...mockRecord,
            broadcastAuthorization: {
              ...mockRecord.broadcastAuthorization!,
              expiresAt: 8888
            }
          }
        })
      }).toThrow(/INVALID_DISPATCH_INTENT_RECORD/)

      // Mismatched broadcastAuthorization consumedAt
      expect(() => {
        assertTm1CommittedDispatchIntentBinding({
          ...input,
          committedRecord: {
            ...mockRecord,
            broadcastAuthorization: {
              ...mockRecord.broadcastAuthorization!,
              consumedAt: 8888
            }
          }
        })
      }).toThrow(/INVALID_DISPATCH_INTENT_RECORD/)

      // Mismatched dispatchIntent committedAt precision
      expect(() => {
        assertTm1CommittedDispatchIntentBinding({
          ...input,
          expectedCommittedAt: 700
        })
      }).toThrow(/INVALID_DISPATCH_INTENT_RECORD: Dispatch intent committedAt mismatch/)

      // Mismatched expectedRecord deep equality
      expect(() => {
        assertTm1CommittedDispatchIntentBinding({
          ...input,
          expectedRecord: {
            ...mockRecord,
            ownerEpoch: 2
          }
        })
      }).toThrow(/INVALID_DISPATCH_INTENT_RECORD/)
    })

    test('Slot ID is store-scoped and uniquely bound to store identity (Finding 1)', async () => {
      const customStoreId = `tm1-store:v1:${'44'.repeat(32)}`
      expect(deriveStoreSlotId(customStoreId)).toBe(`slot:${customStoreId}`)

      const store = new Tm1HarnessRecoveryStore(customStoreId)
      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        recoveryStore: store
      })
      expect(harness.getSlotId()).toBe(`slot:${customStoreId}`)

      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()
      const step5 = await harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)
      const step6 = await harness.executeStep6ReserveRecoveryAndDispatch(
        step4.preparedReview,
        step5.signedReview
      )
      // Witness slot is storeId-scoped, NOT preparedId-scoped
      expect(step6.witnessReservationSnapshot.stable.slotId).toBe(`slot:${customStoreId}`)
      expect(step6.witnessFinalizedDispatchSnapshot.stable.slotId).toBe(`slot:${customStoreId}`)
      expect(step6.witnessReservationSnapshot.stable.slotId).not.toBe(
        `slot:${step4.preparedReview.preparedId}`
      )
    })

    test('Rejects with UNENROLLED_NONEMPTY_STORE when store has records but witness slot is null (Finding 1)', async () => {
      const store = new Tm1HarnessRecoveryStore()
      expect(await isStoreNonEmpty(store)).toBe(false)

      // Seed store with an existing record
      const fakeRecord = parseTm1PublicationRecoveryRecord({
        schema: 'tonalli.tm1-publication-recovery',
        schemaVersion: 1,
        publicationId: 'pub:seed-1',
        revision: 1,
        ownerEpoch: 1,
        phase: 'preDispatch',
        preDispatchStage: 'broadcastAuthorizationConsumed',
        prepared: {
          preparedId: 'prep:seed',
          bindingHash: '11'.repeat(32),
          preparedDigest: '11'.repeat(32)
        },
        signed: {
          signedId: 'signed:seed',
          txid: '22'.repeat(32),
          signedArtifactHash: '33'.repeat(32)
        },
        signingAuthorization: {
          operationId: 'op:s',
          capabilityId: 'cap:s',
          contentHash: `sha256:${'11'.repeat(32)}` as const,
          expiresAt: 1000,
          consumedAt: 500,
          preparedId: 'prep:seed',
          bindingHash: '11'.repeat(32)
        },
        broadcastAuthorization: {
          operationId: 'op:b',
          capabilityId: 'cap:b',
          contentHash: `sha256:${'22'.repeat(32)}` as const,
          expiresAt: 1000,
          consumedAt: 500,
          signedId: 'signed:seed',
          txid: '22'.repeat(32),
          signedArtifactHash: '33'.repeat(32)
        },
        dispatchIntent: null,
        transportAcknowledgement: null,
        lastObservation: null,
        terminal: null
      })
      await store.create({ record: fakeRecord })
      expect(await isStoreNonEmpty(store)).toBe(true)

      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        recoveryStore: store
      })

      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()
      const step5 = await harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)

      // In Step 6: witness slot is unenrolled (read returns null), but store is non-empty -> abort
      await expect(
        harness.executeStep6ReserveRecoveryAndDispatch(
          step4.preparedReview,
          step5.signedReview
        )
      ).rejects.toThrow(/UNENROLLED_NONEMPTY_STORE/)
    })

    test('Rejects with STORE_ROLLBACK_DETECTED in Step 6 if store root differs from witness stable head (Finding 2)', async () => {
      // Unit test of assertion helper
      const mockStable = {
        protocol: 'tonalli.tm1-rollback-witness' as const,
        protocolVersion: 1 as const,
        slotId: 'slot:test',
        storeId: `tm1-store:v1:${'11'.repeat(32)}`,
        generation: 0,
        logicalRoot: '00'.repeat(32),
        receiptHash: 'aa'.repeat(32),
        witnessKeyId: 'wk-1',
        state: 'stable' as const,
        operationId: 'op:0',
        previousStableReceiptHash: null,
        authenticatedReceipt: 'auth-0'
      }
      expect(() => {
        assertStoreConsistentWithWitnessStableHead('00'.repeat(32), mockStable)
      }).not.toThrow()
      expect(() => {
        assertStoreConsistentWithWitnessStableHead('ff'.repeat(32), mockStable)
      }).toThrow(/STORE_ROLLBACK_DETECTED/)

      // Step 6 integration test: witness has enrolled root X, but store derives root Y
      const realWitness = new Tm1InMemoryRollbackWitness()
      const storeId = `tm1-store:v1:${'55'.repeat(32)}`
      const slotId = deriveStoreSlotId(storeId)
      const store = new Tm1HarnessRecoveryStore(storeId)
      const storeRoot = store.computeEnrollmentLogicalRoot({ slotId, storeId })
      store.enrollWitnessBinding({
        slotId,
        storeId,
        logicalRoot: storeRoot
      })
      // Pre-enroll slot on witness with a mismatched root
      await realWitness.enroll({
        slotId,
        storeId,
        logicalRoot: 'fe'.repeat(32),
        operationId: 'op:enroll'
      })

      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        recoveryStore: store,
        witness: realWitness
      })

      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()
      const step5 = await harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)

      await expect(
        harness.executeStep6ReserveRecoveryAndDispatch(
          step4.preparedReview,
          step5.signedReview
        )
      ).rejects.toThrow(/STORE_ROLLBACK_DETECTED/)
    })

    test('Step 6: rejects with UNBOUND_LOCAL_STORE_WITH_ENROLLED_WITNESS when witness is enrolled but local store is unbound (Finding 1 / P1)', async () => {
      const realWitness = new Tm1InMemoryRollbackWitness()
      const storeId = `tm1-store:v1:${'77'.repeat(32)}`
      const slotId = deriveStoreSlotId(storeId)

      // Pre-enroll slot on witness (simulating remote witness was enrolled)
      await realWitness.enroll({
        slotId,
        storeId,
        logicalRoot: '00'.repeat(32),
        operationId: 'op:enroll'
      })

      // Store is fresh and unbound (simulating crash before enrollWitnessBinding was persisted)
      const unboundStore = new Tm1HarnessRecoveryStore(storeId)
      expect(unboundStore.inspectWitnessBinding()).toBeNull()

      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        recoveryStore: unboundStore,
        witness: realWitness
      })

      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()
      const step5 = await harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)

      await expect(
        harness.executeStep6ReserveRecoveryAndDispatch(
          step4.preparedReview,
          step5.signedReview
        )
      ).rejects.toThrow(/UNBOUND_LOCAL_STORE_WITH_ENROLLED_WITNESS/)

      expect(harness.getDispatchCount()).toBe(0)
    })

    test('Successfully accepts and canonicalizes alias without .xec and uppercase owner address (Finding 2 / P2)', async () => {
      const bareAlias = 'satoshi'
      const uppercaseOwner = TEST_OWNER.toUpperCase()
      expect(bareAlias.endsWith('.xec')).toBe(false)
      expect(uppercaseOwner).not.toBe(TEST_OWNER)

      const harness = createTm1RegtestE2eHarness({
        alias: bareAlias,
        ownerAddress: uppercaseOwner
      })

      // Harness fields must be stored canonicalized
      expect(harness.alias).toBe('satoshi.xec')
      expect(harness.ownerAddress).toBe(TEST_OWNER)

      // Step 1: verify alias (mock fetch responds to canonical satoshi.xec)
      setupMockFetch('satoshi.xec', TEST_OWNER)
      const evidenceToken = await harness.executeStep1VerifyAlias()

      // Step 2: produce evidence must match canonical alias and owner without ALIAS_EVIDENCE_UNTRUSTED
      const verifiedSnapshot = harness.executeStep2ProduceEvidence(evidenceToken)
      expect(verifiedSnapshot.alias).toBe('satoshi.xec')
      expect(verifiedSnapshot.address).toBe(TEST_OWNER)

      // Step 3: authorize publication
      const auth = harness.executeStep3AuthorizePublication(evidenceToken)
      expect(auth.alias).toBe('satoshi.xec')
      expect(auth.ownerAddress).toBe(TEST_OWNER)

      // Steps 4 to 7 run through end-to-end without error
      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx(auth)
      const step5 = await harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)
      const step6 = await harness.executeStep6ReserveRecoveryAndDispatch(
        step4.preparedReview,
        step5.signedReview
      )
      const step7 = await harness.executeStep7VerifyFinalSuccess(
        step4.preparedReview,
        step5.signedReview,
        step6.submissionReceipt,
        step6.witnessReservationSnapshot
      )
      expect(step7.transportAcknowledgedRecord.phase).toBe('submittedObserved')
    })

    test('Unit tests for canonicalizeHarnessAlias and canonicalizeHarnessOwnerAddress (Finding 2 / P2)', () => {
      expect(canonicalizeHarnessAlias('satoshi')).toBe('satoshi.xec')
      expect(canonicalizeHarnessAlias('satoshi.xec')).toBe('satoshi.xec')
      expect(canonicalizeHarnessAlias('SATOSHI')).toBe('satoshi.xec')
      expect(canonicalizeHarnessAlias('SATOSHI.XEC')).toBe('satoshi.xec')
      expect(canonicalizeHarnessAlias('  alice  ')).toBe('alice.xec')
      expect(canonicalizeHarnessAlias('  alice.xec  ')).toBe('alice.xec')

      expect(canonicalizeHarnessOwnerAddress(TEST_OWNER.toUpperCase())).toBe(TEST_OWNER)
      expect(canonicalizeHarnessOwnerAddress(`  ${TEST_OWNER.toUpperCase()}  `)).toBe(TEST_OWNER)
      const bareAddress = TEST_OWNER.replace(/^ecash:/, '')
      expect(canonicalizeHarnessOwnerAddress(bareAddress)).toBe(TEST_OWNER)
      expect(canonicalizeHarnessOwnerAddress(bareAddress.toUpperCase())).toBe(TEST_OWNER)
    })

    test('Rejects with STORE_ROLLBACK_DETECTED in Step 7 if store is modified/rolled back before acknowledgement (Finding 2)', async () => {
      const store = new Tm1HarnessRecoveryStore()
      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        recoveryStore: store
      })

      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()
      const step5 = await harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)
      const step6 = await harness.executeStep6ReserveRecoveryAndDispatch(
        step4.preparedReview,
        step5.signedReview
      )

      // Step 6 succeeded: witness is at generation 1, store has outcomeUnknownRecord (rev 2)
      // Now simulate a store rollback: store was wiped or rolled back to an earlier empty state
      ;(store as any).records.clear()

      await expect(
        harness.executeStep7VerifyFinalSuccess(
          step4.preparedReview,
          step5.signedReview,
          step6.submissionReceipt
        )
      ).rejects.toThrow(/STORE_ROLLBACK_DETECTED/)
    })

    test('Rejects with STORE_ROLLBACK_DETECTED in Step 7 if store is reverted to an earlier revision (Finding 2)', async () => {
      const store = new Tm1HarnessRecoveryStore()
      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        recoveryStore: store
      })

      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()
      const step5 = await harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)
      const step6 = await harness.executeStep6ReserveRecoveryAndDispatch(
        step4.preparedReview,
        step5.signedReview
      )

      // Step 6 succeeded: witness is at generation 1, store has outcomeUnknownRecord (rev 2)
      // Simulate rollback to a pre-dispatch revision 1 record
      const pubId = `pub:${step4.preparedReview.preparedId}`
      const rev1Record = parseTm1PublicationRecoveryRecord({
        schema: 'tonalli.tm1-publication-recovery',
        schemaVersion: 1,
        publicationId: pubId,
        revision: 1,
        ownerEpoch: 1,
        phase: 'preDispatch',
        preDispatchStage: 'broadcastAuthorizationConsumed',
        prepared: {
          preparedId: step4.preparedReview.preparedId,
          bindingHash: '11'.repeat(32),
          preparedDigest: '11'.repeat(32)
        },
        signed: {
          signedId: step5.signedReview.signedId,
          txid: step6.submissionReceipt.txid,
          signedArtifactHash: step5.signedReview.signedArtifactHash
        },
        signingAuthorization: {
          operationId: 'op:s',
          capabilityId: 'cap:s',
          contentHash: `sha256:${'11'.repeat(32)}` as const,
          expiresAt: 1000,
          consumedAt: 500,
          preparedId: step4.preparedReview.preparedId,
          bindingHash: '11'.repeat(32)
        },
        broadcastAuthorization: {
          operationId: 'op:b',
          capabilityId: 'cap:b',
          contentHash: `sha256:${'22'.repeat(32)}` as const,
          expiresAt: 1000,
          consumedAt: 500,
          signedId: step5.signedReview.signedId,
          txid: step6.submissionReceipt.txid,
          signedArtifactHash: step5.signedReview.signedArtifactHash
        },
        dispatchIntent: null,
        transportAcknowledgement: null,
        lastObservation: null,
        terminal: null
      })
      ;(store as any).records.set(pubId, rev1Record)

      await expect(
        harness.executeStep7VerifyFinalSuccess(
          step4.preparedReview,
          step5.signedReview,
          step6.submissionReceipt
        )
      ).rejects.toThrow(/STORE_ROLLBACK_DETECTED/)
    })

    test('Rejects with UNENROLLED_NONEMPTY_STORE in Step 7 if witness read returns null for non-empty store (Finding 1)', async () => {
      const store = new Tm1HarnessRecoveryStore()
      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        recoveryStore: store,
        witness: {
          read: async () => null,
          enroll: async () => {
            throw new Error('should not enroll')
          },
          reserve: async () => {
            throw new Error('should not reserve')
          },
          finalize: async () => {
            throw new Error('should not finalize')
          },
          verifyRecord: async () => true
        }
      })

      // Add a record to store so it is non-empty
      const pubId = 'pub:dummy'
      const fakeRecord = parseTm1PublicationRecoveryRecord({
        schema: 'tonalli.tm1-publication-recovery',
        schemaVersion: 1,
        publicationId: pubId,
        revision: 1,
        ownerEpoch: 1,
        phase: 'preDispatch',
        preDispatchStage: 'broadcastAuthorizationConsumed',
        prepared: {
          preparedId: 'prep:dummy',
          bindingHash: '11'.repeat(32),
          preparedDigest: '11'.repeat(32)
        },
        signed: {
          signedId: 'signed:dummy',
          txid: '22'.repeat(32),
          signedArtifactHash: '33'.repeat(32)
        },
        signingAuthorization: {
          operationId: 'op:s',
          capabilityId: 'cap:s',
          contentHash: `sha256:${'11'.repeat(32)}` as const,
          expiresAt: 1000,
          consumedAt: 500,
          preparedId: 'prep:dummy',
          bindingHash: '11'.repeat(32)
        },
        broadcastAuthorization: {
          operationId: 'op:b',
          capabilityId: 'cap:b',
          contentHash: `sha256:${'22'.repeat(32)}` as const,
          expiresAt: 1000,
          consumedAt: 500,
          signedId: 'signed:dummy',
          txid: '22'.repeat(32),
          signedArtifactHash: '33'.repeat(32)
        },
        dispatchIntent: null,
        transportAcknowledgement: null,
        lastObservation: null,
        terminal: null
      })
      await store.create({ record: fakeRecord })

      await expect(
        harness.executeStep7VerifyFinalSuccess(
          { preparedId: 'dummy' } as any,
          { signedId: 'dummy', signedArtifactHash: '33'.repeat(32) } as any,
          { submissionId: 'sub:dummy', txid: '22'.repeat(32) } as any
        )
      ).rejects.toThrow(/UNENROLLED_NONEMPTY_STORE/)
    })

    test('Step 7 executes witness reservation before local store commit in strict 2PC order (Finding 3)', async () => {
      const store = new Tm1HarnessRecoveryStore()
      const realWitness = new Tm1InMemoryRollbackWitness()
      const orderOfOperations: string[] = []

      const witnessProxy = {
        read: (args: any) => realWitness.read(args),
        enroll: (args: any) => realWitness.enroll(args),
        reserve: async (args: any) => {
          orderOfOperations.push('witness.reserve')
          return realWitness.reserve(args)
        },
        finalize: async (args: any) => {
          orderOfOperations.push('witness.finalize')
          return realWitness.finalize(args)
        },
        verifyRecord: (args: any) => realWitness.verifyRecord(args)
      }

      // Spy on store commitTransportAcknowledgement
      const originalCommitAck = store.commitTransportAcknowledgement.bind(store)
      store.commitTransportAcknowledgement = async (args: any) => {
        orderOfOperations.push('store.commitAck')
        return originalCommitAck(args)
      }

      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        recoveryStore: store,
        witness: witnessProxy
      })

      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()
      const step5 = await harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)
      const step6 = await harness.executeStep6ReserveRecoveryAndDispatch(
        step4.preparedReview,
        step5.signedReview
      )

      // Reset order log before Step 7
      orderOfOperations.length = 0

      const step7 = await harness.executeStep7VerifyFinalSuccess(
        step4.preparedReview,
        step5.signedReview,
        step6.submissionReceipt
      )

      expect(step7.transportAcknowledgedRecord.revision).toBe(3)
      expect(orderOfOperations).toEqual([
        'witness.reserve',
        'store.commitAck',
        'witness.finalize'
      ])
    })

    test('Step 7 aborts without mutating local store if witness reservation fails (Finding 3)', async () => {
      const store = new Tm1HarnessRecoveryStore()
      const realWitness = new Tm1InMemoryRollbackWitness()
      let failAckReservation = false

      const witnessProxy = {
        read: (args: any) => realWitness.read(args),
        enroll: (args: any) => realWitness.enroll(args),
        reserve: async (args: any) => {
          if (failAckReservation) {
            throw new Error('WITNESS_RESERVATION_FAILED: Network timeout')
          }
          return realWitness.reserve(args)
        },
        finalize: (args: any) => realWitness.finalize(args),
        verifyRecord: (args: any) => realWitness.verifyRecord(args)
      }

      let commitAckCalled = false
      const originalCommitAck = store.commitTransportAcknowledgement.bind(store)
      store.commitTransportAcknowledgement = async (args: any) => {
        commitAckCalled = true
        return originalCommitAck(args)
      }

      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        recoveryStore: store,
        witness: witnessProxy
      })

      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()
      const step5 = await harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)
      const step6 = await harness.executeStep6ReserveRecoveryAndDispatch(
        step4.preparedReview,
        step5.signedReview
      )

      // Now enable failure for Step 7 reservation
      failAckReservation = true

      await expect(
        harness.executeStep7VerifyFinalSuccess(
          step4.preparedReview,
          step5.signedReview,
          step6.submissionReceipt
        )
      ).rejects.toThrow(/WITNESS_RESERVATION_FAILED/)

      // Ensure store was NOT mutated
      expect(commitAckCalled).toBe(false)
      const pubId = `pub:${step4.preparedReview.preparedId}`
      const rawAfterFailure = await store.load(pubId)
      expect(rawAfterFailure).not.toBeNull()
      const recordAfterFailure = parseTm1PublicationRecoveryRecord(rawAfterFailure)
      expect(recordAfterFailure.revision).toBe(2)
      expect(recordAfterFailure.phase).toBe('outcomeUnknown')
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
    test('Generates cryptographically unique publication IDs across harness restarts without collisions (Finding 1)', async () => {
      const sharedStore = new Tm1HarnessRecoveryStore()
      const sharedWitness = new Tm1InMemoryRollbackWitness()

      // Instance 1
      const harness1 = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        recoveryStore: sharedStore,
        witness: sharedWitness
      })

      const h1Step4 = await harness1.executeStep4PrepareMemoAndUnsignedTx()
      const h1Step5 = await harness1.executeStep5DualAuthorizeAndSign(h1Step4.preparedReview)
      const h1Step6 = await harness1.executeStep6ReserveRecoveryAndDispatch(
        h1Step4.preparedReview,
        h1Step5.signedReview
      )
      const h1Step7 = await harness1.executeStep7VerifyFinalSuccess(
        h1Step4.preparedReview,
        h1Step5.signedReview,
        h1Step6.submissionReceipt,
        h1Step6.witnessReservationSnapshot
      )
      expect(h1Step7.transportAcknowledgedRecord.phase).toBe('submittedObserved')

      // Instance 2 (restarted against durable shared store and witness)
      const harness2 = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        recoveryStore: sharedStore,
        witness: sharedWitness
      })

      const h2Step4 = await harness2.executeStep4PrepareMemoAndUnsignedTx()
      // IDs must be distinct and collision-free
      expect(h2Step4.preparedReview.preparedId).not.toBe(h1Step4.preparedReview.preparedId)

      const h2Step5 = await harness2.executeStep5DualAuthorizeAndSign(h2Step4.preparedReview)
      // Step 6 must succeed in creating the record without DUPLICATE_PUBLICATION_ID
      const h2Step6 = await harness2.executeStep6ReserveRecoveryAndDispatch(
        h2Step4.preparedReview,
        h2Step5.signedReview
      )
      expect(h2Step6.submissionReceipt.txid).toBe(h2Step5.signedReview.txid)

      const h2Step7 = await harness2.executeStep7VerifyFinalSuccess(
        h2Step4.preparedReview,
        h2Step5.signedReview,
        h2Step6.submissionReceipt,
        h2Step6.witnessReservationSnapshot
      )
      expect(h2Step7.transportAcknowledgedRecord.phase).toBe('submittedObserved')

      // Both records exist in store
      const list = (await sharedStore.listRecoverable()) as Tm1PublicationRecoveryRecord[]
      expect(list.length).toBe(2)
      expect(list.map(r => r.publicationId)).toContain(`pub:${h1Step4.preparedReview.preparedId}`)
      expect(list.map(r => r.publicationId)).toContain(`pub:${h2Step4.preparedReview.preparedId}`)
    })

    test('Preserves existing capabilities in projected roots for injected store without computeWitnessLogicalRoot (Finding 2)', async () => {
      // Injected store that implements basic Tm1PublicationRecoveryStore WITHOUT computeWitnessLogicalRoot
      const underlying = new Tm1HarnessRecoveryStore()
      const injectedStore = {
        storeId: underlying.storeId,
        load: (id: string) => underlying.load(id),
        listRecoverable: () => underlying.listRecoverable(),
        create: (input: any) => underlying.create(input),
        commitExecutionEvidence: (input: any) => underlying.commitExecutionEvidence(input),
        commitDispatchIntent: (input: any) => underlying.commitDispatchIntent(input),
        commitTransportAcknowledgement: (input: any) => underlying.commitTransportAcknowledgement(input),
        commitRecoveryTransition: (input: any) => underlying.commitRecoveryTransition(input),
        claimOwnership: (input: any) => underlying.claimOwnership(input)
      }
      expect('computeWitnessLogicalRoot' in injectedStore).toBe(false)

      const witness = new Tm1InMemoryRollbackWitness()
      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        recoveryStore: injectedStore as any,
        witness
      })

      // Run publication 1
      const p1Step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()
      const p1Step5 = await harness.executeStep5DualAuthorizeAndSign(p1Step4.preparedReview)
      const p1Step6 = await harness.executeStep6ReserveRecoveryAndDispatch(
        p1Step4.preparedReview,
        p1Step5.signedReview
      )
      await harness.executeStep7VerifyFinalSuccess(
        p1Step4.preparedReview,
        p1Step5.signedReview,
        p1Step6.submissionReceipt,
        p1Step6.witnessReservationSnapshot
      )

      // Run publication 2 on non-empty store
      const harness2 = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        recoveryStore: injectedStore as any,
        witness
      })
      const p2Step4 = await harness2.executeStep4PrepareMemoAndUnsignedTx()
      const p2Step5 = await harness2.executeStep5DualAuthorizeAndSign(p2Step4.preparedReview)
      // Step 6 computes projected root preserving publication 1 capabilities and finalizes witness
      const p2Step6 = await harness2.executeStep6ReserveRecoveryAndDispatch(
        p2Step4.preparedReview,
        p2Step5.signedReview
      )
      // Step 7 checks stable head and commits 2PC without STORE_ROLLBACK_DETECTED
      const p2Step7 = await harness2.executeStep7VerifyFinalSuccess(
        p2Step4.preparedReview,
        p2Step5.signedReview,
        p2Step6.submissionReceipt,
        p2Step6.witnessReservationSnapshot
      )
      expect(p2Step7.transportAcknowledgedRecord.phase).toBe('submittedObserved')
    })

    test('Rejects Step 6 dispatch intent if recovery store tampers with authorization fields or committedAt (Finding 3)', async () => {
      // 1. Recovery store returns tampered signing authorization contentHash
      const tamperedSigningStore = new Tm1HarnessRecoveryStore()
      const originalCommit1 = tamperedSigningStore.commitDispatchIntent.bind(tamperedSigningStore)
      tamperedSigningStore.commitDispatchIntent = async (input: any) => {
        const res = (await originalCommit1(input)) as Tm1PublicationRecoveryRecord
        return {
          ...res,
          signingAuthorization: {
            ...res.signingAuthorization!,
            contentHash: `sha256:${'00'.repeat(32)}`
          }
        }
      }

      const harnessTamperedSigning = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        recoveryStore: tamperedSigningStore
      })
      const s4 = await harnessTamperedSigning.executeStep4PrepareMemoAndUnsignedTx()
      const s5 = await harnessTamperedSigning.executeStep5DualAuthorizeAndSign(s4.preparedReview)
      await expect(
        harnessTamperedSigning.executeStep6ReserveRecoveryAndDispatch(
          s4.preparedReview,
          s5.signedReview
        )
      ).rejects.toThrow(/INVALID_DISPATCH_INTENT_RECORD: Signing authorization/)
      expect(harnessTamperedSigning.getDispatchCount()).toBe(0)

      // 2. Recovery store returns tampered broadcast authorization expiresAt
      const tamperedBroadcastStore = new Tm1HarnessRecoveryStore()
      const originalCommit2 = tamperedBroadcastStore.commitDispatchIntent.bind(tamperedBroadcastStore)
      tamperedBroadcastStore.commitDispatchIntent = async (input: any) => {
        const res = (await originalCommit2(input)) as Tm1PublicationRecoveryRecord
        return {
          ...res,
          broadcastAuthorization: {
            ...res.broadcastAuthorization!,
            expiresAt: res.broadcastAuthorization!.expiresAt + 10_000
          }
        }
      }

      const harnessTamperedBroadcast = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        recoveryStore: tamperedBroadcastStore
      })
      const b4 = await harnessTamperedBroadcast.executeStep4PrepareMemoAndUnsignedTx()
      const b5 = await harnessTamperedBroadcast.executeStep5DualAuthorizeAndSign(b4.preparedReview)
      await expect(
        harnessTamperedBroadcast.executeStep6ReserveRecoveryAndDispatch(
          b4.preparedReview,
          b5.signedReview
        )
      ).rejects.toThrow(/INVALID_DISPATCH_INTENT_RECORD: Broadcast authorization/)
      expect(harnessTamperedBroadcast.getDispatchCount()).toBe(0)

      // 3. Recovery store returns tampered dispatch intent committedAt
      const tamperedCommittedAtStore = new Tm1HarnessRecoveryStore()
      const originalCommit3 = tamperedCommittedAtStore.commitDispatchIntent.bind(tamperedCommittedAtStore)
      tamperedCommittedAtStore.commitDispatchIntent = async (input: any) => {
        const res = (await originalCommit3(input)) as Tm1PublicationRecoveryRecord
        return {
          ...res,
          dispatchIntent: {
            ...res.dispatchIntent!,
            committedAt: res.dispatchIntent!.committedAt + 1000
          }
        }
      }

      const harnessTamperedCommittedAt = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        recoveryStore: tamperedCommittedAtStore
      })
      const c4 = await harnessTamperedCommittedAt.executeStep4PrepareMemoAndUnsignedTx()
      const c5 = await harnessTamperedCommittedAt.executeStep5DualAuthorizeAndSign(c4.preparedReview)
      await expect(
        harnessTamperedCommittedAt.executeStep6ReserveRecoveryAndDispatch(
          c4.preparedReview,
          c5.signedReview
        )
      ).rejects.toThrow(/INVALID_DISPATCH_INTENT_RECORD: Dispatch intent committedAt mismatch/)
      expect(harnessTamperedCommittedAt.getDispatchCount()).toBe(0)
    })

    test('Tm1HarnessRecoveryStore.computeWitnessLogicalRoot strictly expects numeric generation (Finding 1)', () => {
      const store = new Tm1HarnessRecoveryStore()

      // Valid numeric generations return 64-character hex roots
      const root0 = store.computeWitnessLogicalRoot(0)
      expect(root0).toMatch(/^[0-9a-f]{64}$/)
      const root1 = store.computeWitnessLogicalRoot(1)
      expect(root1).toMatch(/^[0-9a-f]{64}$/)
      expect(root1).not.toBe(root0)

      // Rejects legacy object argument with INVALID_GENERATION
      expect(() => {
        ;(store as any).computeWitnessLogicalRoot({
          slotId: 'slot:test',
          generation: 0,
          storeId: store.getStoreId()
        })
      }).toThrow(/INVALID_GENERATION: computeWitnessLogicalRoot expects non-negative safe integer generation/)

      // Rejects non-numbers, negative numbers, and non-integers
      expect(() => (store as any).computeWitnessLogicalRoot(undefined)).toThrow(/INVALID_GENERATION/)
      expect(() => (store as any).computeWitnessLogicalRoot('0')).toThrow(/INVALID_GENERATION/)
      expect(() => (store as any).computeWitnessLogicalRoot(-1)).toThrow(/INVALID_GENERATION/)
      expect(() => (store as any).computeWitnessLogicalRoot(1.5)).toThrow(/INVALID_GENERATION/)
    })

    test('Harness deriveStoreRoot delegates numeric generation to store.computeWitnessLogicalRoot (Finding 1)', async () => {
      const underlying = new Tm1HarnessRecoveryStore()
      const callLog: unknown[] = []
      const trackingStore = {
        storeId: underlying.storeId,
        createdAt: underlying.createdAt,
        load: (id: string) => underlying.load(id),
        listRecoverable: () => underlying.listRecoverable(),
        create: (input: any) => underlying.create(input),
        commitExecutionEvidence: (input: any) => underlying.commitExecutionEvidence(input),
        commitDispatchIntent: (input: any) => underlying.commitDispatchIntent(input),
        commitTransportAcknowledgement: (input: any) => underlying.commitTransportAcknowledgement(input),
        commitRecoveryTransition: (input: any) => underlying.commitRecoveryTransition(input),
        claimOwnership: (input: any) => underlying.claimOwnership(input),
        computeWitnessLogicalRoot: (generation: number) => {
          callLog.push(generation)
          if (typeof generation !== 'number' || !Number.isSafeInteger(generation)) {
            throw new Error(`SQLITE_CONTRACT_VIOLATION: generation must be number, got ${typeof generation}`)
          }
          return underlying.computeWitnessLogicalRoot(generation)
        }
      }

      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        recoveryStore: trackingStore as any
      })

      // Calling deriveStoreRoot without projected records delegates to computeWitnessLogicalRoot passing integer
      const rootGen0 = await harness.deriveStoreRoot({
        slotId: deriveStoreSlotId(underlying.storeId),
        storeId: underlying.storeId,
        generation: 0
      })
      expect(rootGen0).toMatch(/^[0-9a-f]{64}$/)
      expect(callLog).toEqual([0])
      expect(typeof callLog[0]).toBe('number')

      // Run full Step 4-7 to ensure computeWitnessLogicalRoot is called with numbers during re-attestations
      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()
      const step5 = await harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)
      const step6 = await harness.executeStep6ReserveRecoveryAndDispatch(
        step4.preparedReview,
        step5.signedReview
      )
      const step7 = await harness.executeStep7VerifyFinalSuccess(
        step4.preparedReview,
        step5.signedReview,
        step6.submissionReceipt,
        step6.witnessReservationSnapshot
      )
      expect(step7.transportAcknowledgedRecord.phase).toBe('submittedObserved')

      // Every invocation of computeWitnessLogicalRoot received a primitive number
      expect(callLog.length).toBeGreaterThan(1)
      for (const callArg of callLog) {
        expect(typeof callArg).toBe('number')
      }
    })

    test('Step 6 executes sequential SQLite enrollment lifecycle (computeEnrollmentLogicalRoot -> enroll -> enrollWitnessBinding) transitioning v1 to v2 (Finding 2)', async () => {
      const underlying = new Tm1HarnessRecoveryStore()
      let schema: 'v1' | 'v2' = 'v1'
      const lifecycleCalls: string[] = []
      let storedBinding: { slotId: string; storeId: string; logicalRoot: string; generation: number } | null = null

      const sqliteStore = {
        storeId: underlying.storeId,
        createdAt: underlying.createdAt,
        load: (id: string) => underlying.load(id),
        listRecoverable: () => underlying.listRecoverable(),
        create: (input: any) => underlying.create(input),
        commitExecutionEvidence: (input: any) => underlying.commitExecutionEvidence(input),
        commitDispatchIntent: (input: any) => underlying.commitDispatchIntent(input),
        commitTransportAcknowledgement: (input: any) => underlying.commitTransportAcknowledgement(input),
        commitRecoveryTransition: (input: any) => underlying.commitRecoveryTransition(input),
        claimOwnership: (input: any) => underlying.claimOwnership(input),
        inspectWitnessBinding: () => storedBinding,
        computeEnrollmentLogicalRoot: (identity: { slotId: string; storeId: string }) => {
          lifecycleCalls.push(`computeEnrollmentLogicalRoot:${identity.slotId}`)
          if (schema !== 'v1') {
            throw new Error(`SQLITE_LIFECYCLE_ERROR: computeEnrollmentLogicalRoot requires schema v1, current is ${schema}`)
          }
          return underlying.computeEnrollmentLogicalRoot(identity)
        },
        enrollWitnessBinding: (binding: { slotId: string; storeId: string; logicalRoot: string }) => {
          lifecycleCalls.push(`enrollWitnessBinding:${binding.slotId}`)
          if (schema !== 'v1') {
            throw new Error(`SQLITE_LIFECYCLE_ERROR: enrollWitnessBinding requires schema v1, current is ${schema}`)
          }
          schema = 'v2'
          storedBinding = { ...binding, generation: 0 }
          return underlying.enrollWitnessBinding(binding)
        },
        computeWitnessLogicalRoot: (generation: number) => {
          if (schema !== 'v2') {
            throw new Error(`STORE_FAILURE: cannot compute logical root on v1 unenrolled store (generation ${generation})`)
          }
          return underlying.computeWitnessLogicalRoot(generation)
        },
        computeProjectedWitnessLogicalRoot: (projectedRecord: any, generation?: number) => {
          return underlying.computeProjectedWitnessLogicalRoot(projectedRecord, generation)
        }
      }

      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        recoveryStore: sqliteStore as any
      })

      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()
      const step5 = await harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)
      const step6 = await harness.executeStep6ReserveRecoveryAndDispatch(
        step4.preparedReview,
        step5.signedReview
      )

      // Step 6 should have cleanly called computeEnrollmentLogicalRoot first, then enrolled on witness, then enrollWitnessBinding
      const expectedSlotId = deriveStoreSlotId(underlying.storeId)
      expect(lifecycleCalls).toEqual([
        `computeEnrollmentLogicalRoot:${expectedSlotId}`,
        `enrollWitnessBinding:${expectedSlotId}`
      ])
      expect(schema).toBe('v2')
      expect(storedBinding).not.toBeNull()
      expect(harness.getDispatchCount()).toBe(1)

      // And Step 7 should succeed on the enrolled v2 store
      const step7 = await harness.executeStep7VerifyFinalSuccess(
        step4.preparedReview,
        step5.signedReview,
        step6.submissionReceipt,
        step6.witnessReservationSnapshot
      )
      expect(step7.transportAcknowledgedRecord.phase).toBe('submittedObserved')
    })

    test('Step 6 and Step 7 delegate projected roots calculation to store.computeProjectedWitnessLogicalRoot (Finding 3)', async () => {
      const underlying = new Tm1HarnessRecoveryStore()
      const projectedCalls: Array<{
        phase: string
        publicationId: string
        generation?: number
      }> = []

      const delegatingStore = {
        storeId: underlying.storeId,
        createdAt: underlying.createdAt,
        load: (id: string) => underlying.load(id),
        listRecoverable: () => underlying.listRecoverable(),
        create: (input: any) => underlying.create(input),
        commitExecutionEvidence: (input: any) => underlying.commitExecutionEvidence(input),
        commitDispatchIntent: (input: any) => underlying.commitDispatchIntent(input),
        commitTransportAcknowledgement: (input: any) => underlying.commitTransportAcknowledgement(input),
        commitRecoveryTransition: (input: any) => underlying.commitRecoveryTransition(input),
        claimOwnership: (input: any) => underlying.claimOwnership(input),
        inspectWitnessBinding: () => underlying.inspectWitnessBinding(),
        computeEnrollmentLogicalRoot: (identity: any) => underlying.computeEnrollmentLogicalRoot(identity),
        enrollWitnessBinding: (binding: any) => underlying.enrollWitnessBinding(binding),
        computeWitnessLogicalRoot: (generation: number) => underlying.computeWitnessLogicalRoot(generation),
        computeProjectedWitnessLogicalRoot: (projectedRecord: any, generation?: number) => {
          projectedCalls.push({
            phase: projectedRecord.phase,
            publicationId: projectedRecord.publicationId,
            generation
          })
          return underlying.computeProjectedWitnessLogicalRoot(projectedRecord, generation)
        }
      }

      const harness = createTm1RegtestE2eHarness({
        alias: TEST_ALIAS,
        ownerAddress: TEST_OWNER,
        recoveryStore: delegatingStore as any
      })

      const step4 = await harness.executeStep4PrepareMemoAndUnsignedTx()
      const step5 = await harness.executeStep5DualAuthorizeAndSign(step4.preparedReview)
      const step6 = await harness.executeStep6ReserveRecoveryAndDispatch(
        step4.preparedReview,
        step5.signedReview
      )

      // Step 6 projected reservation must have called computeProjectedWitnessLogicalRoot
      expect(projectedCalls.length).toBe(1)
      expect(projectedCalls[0].phase).toBe('outcomeUnknown')
      expect(projectedCalls[0].publicationId).toBe(step6.dispatchIntentRecord.publicationId)
      expect(projectedCalls[0].generation).toBe(1)

      const step7 = await harness.executeStep7VerifyFinalSuccess(
        step4.preparedReview,
        step5.signedReview,
        step6.submissionReceipt,
        step6.witnessReservationSnapshot
      )

      // Step 7 projected acknowledgement reservation must have called computeProjectedWitnessLogicalRoot
      expect(projectedCalls.length).toBe(2)
      expect(projectedCalls[1].phase).toBe('submittedObserved')
      expect(projectedCalls[1].publicationId).toBe(step6.dispatchIntentRecord.publicationId)
      expect(projectedCalls[1].generation).toBe(2)

      expect(step7.transportAcknowledgedRecord.phase).toBe('submittedObserved')
    })
  })
})
