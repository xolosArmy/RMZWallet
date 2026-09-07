import {
  Tx
} from 'ecash-lib'
import {
  Tm1AliasOwnershipVerificationError,
  Tm1AliasOwnershipVerificationPort,
  createTm1AliasOwnershipVerificationPort,
  lookupTm1VerifiedAliasOwnershipToken,
  type Tm1VerifiedAliasOwnershipSnapshot
} from './tm1AliasOwnershipVerificationPort'
import {
  Tm1AliasPublicationAuthorizer,
  createTm1AliasPublicationAuthorizer,
  type Tm1AliasPublicationAuthorization
} from './tm1AliasPublicationAuthorization'
import {
  encodeTm1Draft02Post,
  type Tm1Draft02PostPreview
} from './tm1Draft02'
import {
  TM1_DRAFT_02_STANDARD_AUTHOR_INPUT_INDEX,
  type Tm1Draft02FundingUtxo
} from './tm1Draft02Plan'
import {
  type Tm1Draft02Candidate,
  type Tm1Draft02FreshUtxo
} from './tm1Draft02Candidate'
import {
  auditTm1Draft02UnsignedTransaction,
  serializeTm1Draft02UnsignedTransaction,
  type AuditedTm1Draft02UnsignedTransaction
} from './tm1Draft02UnsignedTransaction'
import {
  TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX,
  auditTm1Draft02RegtestSignedTransaction,
  signTm1Draft02RegtestCandidate,
  type RegtestSignedTransaction
} from './tm1Draft02RegtestP2pkhSigner'
import {
  Tm1InMemoryDeliveryTransport,
  type Tm1RegtestDeliveryReceipt,
  type Tm1RegtestDeliveryTransport,
  type Tm1RegtestNetworkAttestation
} from './tm1RegtestDeliveryTransport'
import {
  createTm1RegtestDualAuthorizationPorts
} from './tm1RegtestDualAuthorizationComposition'
import type {
  Tm1RegtestAuthorizationDecisionProvider,
  Tm1RegtestAuthorizationProviderDecision
} from './tm1RegtestAuthorizationAdapter'
import type {
  Tm1RegtestBroadcastAuthorizationDecisionProvider,
  Tm1RegtestBroadcastAuthorizationProviderDecision
} from './tm1RegtestBroadcastAuthorizationAdapter'
import {
  Tm1PublicationError,
  Tm1RegtestPublicationOrchestratorImpl,
  type Tm1Confirmation,
  type Tm1ConfirmationObserverPort,
  type Tm1PreparedReview,
  type Tm1PublicationAuthorizationDecision,
  type Tm1PublicationClock,
  type Tm1PublicationState,
  type Tm1RegtestPublicationDependencies,
  type Tm1RegtestPublicationOrchestrator,
  type Tm1SignedReview,
  type Tm1SubmissionReceipt
} from './tm1RegtestPublicationOrchestrator'
import {
  type Tm1RollbackWitness,
  type Tm1RollbackWitnessSnapshot
} from './recovery/tm1RollbackWitness'
import {
  Tm1InMemoryRollbackWitness
} from './recovery/tm1InMemoryRollbackWitness'
import {
  assertTm1DispatchIntentTransition,
  assertTm1ExecutionEvidenceTransition,
  assertTm1OwnershipTransition,
  assertTm1RecoveryTransition,
  assertTm1TransportAcknowledgementTransition,
  consumedCapabilityIds,
  createTm1TransportAcknowledgedRecord,
  parseTm1PublicationRecoveryRecord,
  type Tm1PublicationRecoveryRecord
} from './recovery/tm1PublicationRecoveryModel'
import {
  Tm1PublicationRecoveryStoreError,
  type Tm1PublicationRecoveryStore,
  type Tm1RecoveryStoreCreate,
  type Tm1RecoveryStoreDispatchIntentCommit,
  type Tm1RecoveryStoreExecutionCommit,
  type Tm1RecoveryStoreOwnershipClaim,
  type Tm1RecoveryStoreRecoveryCommit,
  type Tm1RecoveryStoreTransportAcknowledgementCommit
} from './recovery/tm1PublicationRecoveryStore'
import type {
  ApprovalConsumption,
  ApprovalConsumptionLedger
} from '../../features/externalSign/approval'
import {
  UniversalAuthorizationError
} from '../../features/externalSign/contract'
import type {
  UniversalOperationLease,
  UniversalOperationLock
} from '../../features/externalSign/lock'

export const TM1_PROGRAMMATIC_E2E_FIXTURE_ADDRESS =
  'ecash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cacy2kzvq'

export const DEFAULT_TM1_PROGRAMMATIC_E2E_MESSAGE =
  'Tonalli Memo TM1 E2E Programmatic Integration'

export function createDefaultFixtureUtxos(
  lockingScriptHex: string = TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX,
  sats: bigint = 100_000n
): readonly Tm1Draft02FreshUtxo[] {
  return Object.freeze([
    Object.freeze({
      txid: '33'.repeat(32),
      outIdx: 0,
      sats,
      lockingScriptHex
    })
  ])
}

export class Tm1HarnessOperationLease implements UniversalOperationLease {
  readonly ownerOperationId: string
  private owned = true
  private readonly onRelease: () => void

  constructor(ownerOperationId: string, onRelease: () => void) {
    this.ownerOperationId = ownerOperationId
    this.onRelease = onRelease
  }

  isOwned(): boolean {
    return this.owned
  }

  release(): void {
    if (!this.owned) {
      throw new UniversalAuthorizationError('LEASE_ALREADY_RELEASED')
    }
    this.owned = false
    this.onRelease()
  }
}

export class Tm1HarnessOperationLock implements UniversalOperationLock {
  private activeLease: Tm1HarnessOperationLease | null = null

  async acquire(
    operationId: string,
    signal: AbortSignal
  ): Promise<UniversalOperationLease> {
    if (signal.aborted) {
      throw new UniversalAuthorizationError('OPERATION_ABORTED')
    }
    if (this.activeLease?.isOwned()) {
      throw new UniversalAuthorizationError('OPERATION_ALREADY_ACTIVE')
    }
    const lease = new Tm1HarnessOperationLease(operationId, () => {
      if (this.activeLease === lease) {
        this.activeLease = null
      }
    })
    this.activeLease = lease
    return lease
  }
}

export class Tm1HarnessApprovalLedger implements ApprovalConsumptionLedger {
  private readonly consumedIds = new Set<string>()

  async consume(
    consumption: ApprovalConsumption,
    signal: AbortSignal
  ): Promise<void> {
    if (signal.aborted) {
      throw new UniversalAuthorizationError('OPERATION_ABORTED')
    }
    if (this.consumedIds.has(consumption.capabilityId)) {
      throw new UniversalAuthorizationError('APPROVAL_ALREADY_CONSUMED')
    }
    this.consumedIds.add(consumption.capabilityId)
  }
}

export class Tm1HarnessRecoveryStore implements Tm1PublicationRecoveryStore {
  private readonly records = new Map<string, Tm1PublicationRecoveryRecord>()
  private readonly capabilityIds = new Set<string>()

  constructor(...initialRecords: readonly Tm1PublicationRecoveryRecord[]) {
    for (const record of initialRecords) {
      this.insertInitial(record)
    }
  }

  async load(publicationId: string): Promise<unknown | null> {
    return this.records.get(publicationId) ?? null
  }

  async listRecoverable(): Promise<unknown> {
    return [...this.records.values()]
  }

  async create(input: Tm1RecoveryStoreCreate): Promise<unknown> {
    const record = parseTm1PublicationRecoveryRecord(input.record)
    if (this.records.has(record.publicationId)) {
      throw new Tm1PublicationRecoveryStoreError('DUPLICATE_PUBLICATION_ID')
    }
    this.reserveCapabilities(consumedCapabilityIds(record))
    this.records.set(record.publicationId, record)
    return record
  }

  async commitExecutionEvidence(
    input: Tm1RecoveryStoreExecutionCommit
  ): Promise<unknown> {
    const current = this.current(input)
    const next = parseTm1PublicationRecoveryRecord(input.nextRecord)
    assertTm1ExecutionEvidenceTransition(current, next)
    const expectedNew = consumedCapabilityIds(next).filter(
      id => !consumedCapabilityIds(current).includes(id)
    )
    this.reserveCapabilities(expectedNew)
    this.records.set(current.publicationId, next)
    return next
  }

  async commitDispatchIntent(
    input: Tm1RecoveryStoreDispatchIntentCommit
  ): Promise<unknown> {
    const current = this.current(input)
    const next = parseTm1PublicationRecoveryRecord(input.nextRecord)
    assertTm1DispatchIntentTransition(current, next)
    this.records.set(current.publicationId, next)
    return next
  }

  async commitTransportAcknowledgement(
    input: Tm1RecoveryStoreTransportAcknowledgementCommit
  ): Promise<unknown> {
    const current = this.current(input)
    const next = createTm1TransportAcknowledgedRecord(
      current,
      input.acknowledgement
    )
    assertTm1TransportAcknowledgementTransition(current, next)
    this.records.set(current.publicationId, next)
    return next
  }

  async commitRecoveryTransition(
    input: Tm1RecoveryStoreRecoveryCommit
  ): Promise<unknown> {
    const current = this.current(input)
    const next = parseTm1PublicationRecoveryRecord(input.nextRecord)
    assertTm1RecoveryTransition(current, next)
    this.records.set(current.publicationId, next)
    return next
  }

  async claimOwnership(
    input: Tm1RecoveryStoreOwnershipClaim
  ): Promise<unknown> {
    const current = this.current(input)
    if (
      !Number.isSafeInteger(input.nextOwnerEpoch) ||
      input.nextOwnerEpoch <= current.ownerEpoch
    ) {
      throw new Tm1PublicationRecoveryStoreError('STALE_OWNER_EPOCH')
    }
    const next = parseTm1PublicationRecoveryRecord({
      ...current,
      revision: current.revision + 1,
      ownerEpoch: input.nextOwnerEpoch
    })
    assertTm1OwnershipTransition(current, next)
    this.records.set(current.publicationId, next)
    return next
  }

  private insertInitial(recordValue: Tm1PublicationRecoveryRecord): void {
    const record = parseTm1PublicationRecoveryRecord(recordValue)
    if (this.records.has(record.publicationId)) {
      throw new Tm1PublicationRecoveryStoreError('DUPLICATE_PUBLICATION_ID')
    }
    this.reserveCapabilities(consumedCapabilityIds(record))
    this.records.set(record.publicationId, record)
  }

  private current(input: {
    publicationId: string
    expectedRevision: number
    expectedOwnerEpoch: number
  }): Tm1PublicationRecoveryRecord {
    const current = this.records.get(input.publicationId)
    if (!current) {
      throw new Tm1PublicationRecoveryStoreError('PUBLICATION_NOT_FOUND')
    }
    if (current.revision !== input.expectedRevision) {
      throw new Tm1PublicationRecoveryStoreError('REVISION_MISMATCH')
    }
    if (current.ownerEpoch !== input.expectedOwnerEpoch) {
      throw new Tm1PublicationRecoveryStoreError('STALE_OWNER_EPOCH')
    }
    return current
  }

  private reserveCapabilities(capabilityIds: readonly string[]): void {
    for (const capabilityId of capabilityIds) {
      if (this.capabilityIds.has(capabilityId)) {
        throw new Tm1PublicationRecoveryStoreError('DUPLICATE_CAPABILITY_CONSUMPTION')
      }
    }
    for (const capabilityId of capabilityIds) {
      this.capabilityIds.add(capabilityId)
    }
  }
}

export type Tm1ProgrammaticE2eOptions = Readonly<{
  alias?: string
  ownerAddress?: string
  message?: string
  maxFeeSats?: bigint
  verificationPort?: Tm1AliasOwnershipVerificationPort
  aliasAuthorizer?: Tm1AliasPublicationAuthorizer
  witness?: Tm1RollbackWitness
  recoveryStore?: Tm1PublicationRecoveryStore
  utxos?: readonly Tm1Draft02FreshUtxo[]
  activeLockingScriptHex?: string
  signingDecisionProvider?: Tm1RegtestAuthorizationDecisionProvider
  broadcastDecisionProvider?: Tm1RegtestBroadcastAuthorizationDecisionProvider
  deliveryTransport?: Tm1RegtestDeliveryTransport
  confirmationObserver?: Tm1ConfirmationObserverPort
  signal?: AbortSignal
}>

export type Tm1ProgrammaticE2eStepResults = Readonly<{
  verifiedAliasEvidenceToken: object
  verifiedAliasSnapshot: Tm1VerifiedAliasOwnershipSnapshot
  aliasPublicationAuthorization: Tm1AliasPublicationAuthorization
  memoPreview: Tm1Draft02PostPreview
  candidate: Tm1Draft02Candidate
  unsignedTransactionBytes: Uint8Array
  unsignedTransactionAudit: AuditedTm1Draft02UnsignedTransaction
  preparedReview: Tm1PreparedReview
  signingAuthorizationDecision: Tm1PublicationAuthorizationDecision
  signedReview: Tm1SignedReview
  witnessReservationSnapshot: Tm1RollbackWitnessSnapshot
  dispatchIntentRecord: Tm1PublicationRecoveryRecord
  submissionReceipt: Tm1SubmissionReceipt
  dispatchCount: number
  transportAcknowledgedRecord: Tm1PublicationRecoveryRecord
  finalOrchestratorState: Tm1PublicationState
  confirmedReceipt?: Tm1Confirmation
}>

export type Tm1ProgrammaticE2eResult = Readonly<{
  success: true
  alias: string
  ownerAddress: string
  txid: string
  submissionId: string
  steps: Tm1ProgrammaticE2eStepResults
}>

export class Tm1RegtestE2eHarness {
  readonly alias: string
  readonly ownerAddress: string
  readonly message: string
  readonly maxFeeSats: bigint
  readonly activeLockingScriptHex: string
  readonly utxos: readonly Tm1Draft02FreshUtxo[]
  readonly verificationPort: Tm1AliasOwnershipVerificationPort
  readonly aliasAuthorizer: Tm1AliasPublicationAuthorizer
  readonly witness: Tm1RollbackWitness
  readonly recoveryStore: Tm1PublicationRecoveryStore
  readonly deliveryTransport: Tm1RegtestDeliveryTransport
  readonly orchestrator: Tm1RegtestPublicationOrchestrator
  private dispatchCalls = 0
  private plannedSubmissionId: string | null = null

  constructor(options: Tm1ProgrammaticE2eOptions = {}) {
    this.alias = options.alias ?? 'satoshi.xec'
    this.ownerAddress = options.ownerAddress ?? TM1_PROGRAMMATIC_E2E_FIXTURE_ADDRESS
    this.message = options.message ?? DEFAULT_TM1_PROGRAMMATIC_E2E_MESSAGE
    this.maxFeeSats = options.maxFeeSats ?? 10_000n
    this.activeLockingScriptHex =
      options.activeLockingScriptHex ?? TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX
    this.utxos = options.utxos ?? createDefaultFixtureUtxos(this.activeLockingScriptHex)

    this.verificationPort =
      options.verificationPort ?? createTm1AliasOwnershipVerificationPort()
    this.aliasAuthorizer =
      options.aliasAuthorizer ?? createTm1AliasPublicationAuthorizer()
    this.witness = options.witness ?? new Tm1InMemoryRollbackWitness()
    this.recoveryStore = options.recoveryStore ?? new Tm1HarnessRecoveryStore()

    const rawTransport =
      options.deliveryTransport ?? new Tm1InMemoryDeliveryTransport()
    this.deliveryTransport = Object.freeze({
      attestNetwork: (sig?: AbortSignal) => rawTransport.attestNetwork(sig),
      submit: async (artifact: RegtestSignedTransaction, sig?: AbortSignal) => {
        this.dispatchCalls += 1
        return rawTransport.submit(artifact, sig)
      }
    })

    const lock = new Tm1HarnessOperationLock()
    const ledger = new Tm1HarnessApprovalLedger()

    const signingDecisionProvider: Tm1RegtestAuthorizationDecisionProvider =
      options.signingDecisionProvider ?? {
        requestDecision: async (): Promise<Tm1RegtestAuthorizationProviderDecision> => ({
          status: 'approved'
        })
      }

    const broadcastDecisionProvider: Tm1RegtestBroadcastAuthorizationDecisionProvider =
      options.broadcastDecisionProvider ?? {
        requestDecision: async (): Promise<Tm1RegtestBroadcastAuthorizationProviderDecision> => ({
          status: 'approved'
        })
      }

    let opSeq = 0
    const dualPorts = createTm1RegtestDualAuthorizationPorts({
      core: {
        enabled: true,
        lock,
        approvalLedger: ledger
      },
      now: () => Date.now(),
      createOperationIdSuffix: () => `e2e-op-${++opSeq}`,
      signing: {
        decisionProvider: signingDecisionProvider,
        ttlMs: 300_000,
        requester: {
          declaredOrigin: 'https://wallet.tonalli.app',
          displayName: 'Tonalli Wallet E2E'
        }
      },
      broadcast: {
        decisionProvider: broadcastDecisionProvider,
        ttlMs: 300_000,
        requester: {
          declaredOrigin: 'https://wallet.tonalli.app',
          displayName: 'Tonalli Wallet E2E'
        }
      }
    })

    let idSeq = 0
    const clock: Tm1PublicationClock = {
      createId: (prefix: 'prepared' | 'signed' | 'submission') => {
        if (prefix === 'submission' && this.plannedSubmissionId !== null) {
          const id = this.plannedSubmissionId
          this.plannedSubmissionId = null
          return id
        }
        return `${prefix}-e2e-${++idSeq}`
      }
    }

    const confirmationObserver: Tm1ConfirmationObserverPort =
      options.confirmationObserver ?? {
        confirm: async ({ submissionId, txid, signal }) => {
          if (signal?.aborted) throw new Tm1PublicationError('ABORTED')
          return {
            submissionId,
            txid,
            confirmations: 1,
            blockHeight: 800_001,
            confirmedAt: Date.now()
          }
        }
      }

    const orchestratorDeps: Tm1RegtestPublicationDependencies = {
      networkAttestation: {
        attest: async (signal?: AbortSignal): Promise<Tm1RegtestNetworkAttestation> => {
          if (signal?.aborted) throw new Tm1PublicationError('ABORTED')
          return this.deliveryTransport.attestNetwork(signal)
        }
      },
      utxoProvider: {
        readUtxos: async (
          signal?: AbortSignal
        ): Promise<readonly Tm1Draft02FundingUtxo[]> => {
          if (signal?.aborted) throw new Tm1PublicationError('ABORTED')
          return this.utxos
        }
      },
      signingAuthorization: dualPorts.signingAuthorization,
      signer: {
        sign: async (
          review: Tm1PreparedReview,
          signal?: AbortSignal
        ): Promise<RegtestSignedTransaction> => {
          if (signal?.aborted) throw new Tm1PublicationError('ABORTED')
          return signTm1Draft02RegtestCandidate({
            candidate: review.candidate,
            signal
          })
        }
      },
      signedArtifactAudit: {
        auditSignedArtifact: async (input: Readonly<{
          review: Tm1PreparedReview
          signedArtifact: RegtestSignedTransaction
          signal?: AbortSignal
        }>): Promise<RegtestSignedTransaction> => {
          if (input.signal?.aborted) throw new Tm1PublicationError('ABORTED')
          auditTm1Draft02RegtestSignedTransaction({
            candidate: input.review.candidate,
            signedTransaction: Tx.fromHex(input.signedArtifact.rawTransactionHex)
          })
          return input.signedArtifact
        }
      },
      broadcastAuthorization: dualPorts.broadcastAuthorization,
      deliveryTransport: {
        broadcast: async (
          artifact: RegtestSignedTransaction
        ): Promise<Tm1RegtestDeliveryReceipt> => {
          return this.deliveryTransport.submit(artifact)
        }
      },
      confirmationObserver,
      clock
    }

    this.orchestrator = new Tm1RegtestPublicationOrchestratorImpl(orchestratorDeps)
  }

  getDispatchCount(): number {
    return this.dispatchCalls
  }

  /**
   * Step 1: Resolver un alias .xec simulado y observar el ownership a traves de tm1AliasOwnershipVerificationPort.
   */
  async executeStep1VerifyAlias(signal?: AbortSignal): Promise<object> {
    if (signal !== undefined) {
      return this.verificationPort.verify({
        alias: this.alias,
        ownerAddress: this.ownerAddress,
        signal
      })
    }
    return this.verificationPort.verify({
      alias: this.alias,
      ownerAddress: this.ownerAddress
    })
  }

  /**
   * Step 2: Producir la VerifiedAliasOwnershipEvidence.
   */
  executeStep2ProduceEvidence(evidenceToken: object): Tm1VerifiedAliasOwnershipSnapshot {
    const snapshot = lookupTm1VerifiedAliasOwnershipToken(evidenceToken)
    if (!snapshot) {
      throw new Tm1AliasOwnershipVerificationError('ALIAS_EVIDENCE_UNTRUSTED')
    }
    if (snapshot.alias !== this.alias) {
      throw new Tm1AliasOwnershipVerificationError('ALIAS_EVIDENCE_UNTRUSTED')
    }
    if (snapshot.address !== this.ownerAddress) {
      throw new Tm1AliasOwnershipVerificationError('ALIAS_EVIDENCE_UNTRUSTED')
    }
    return snapshot
  }

  /**
   * Step 3: Pasar la evidencia verificada al autorizador (tm1AliasPublicationAuthorization).
   */
  executeStep3AuthorizePublication(
    evidenceToken: object
  ): Tm1AliasPublicationAuthorization {
    return this.aliasAuthorizer.issue({
      alias: this.alias,
      ownerAddress: this.ownerAddress,
      evidence: evidenceToken
    })
  }

  /**
   * Step 4: Preparar el memo TM1 canonico y la transaccion sin firmar (unsigned tx).
   */
  async executeStep4PrepareMemoAndUnsignedTx(signal?: AbortSignal): Promise<{
    memoPreview: Tm1Draft02PostPreview
    candidate: Tm1Draft02Candidate
    unsignedTransactionBytes: Uint8Array
    unsignedTransactionAudit: AuditedTm1Draft02UnsignedTransaction
    preparedReview: Tm1PreparedReview
  }> {
    const memoPreview = encodeTm1Draft02Post({
      eventData: this.message,
      authorInputIndex: TM1_DRAFT_02_STANDARD_AUTHOR_INPUT_INDEX
    })

    const preparedReview = await this.orchestrator.prepare(
      {
        message: this.message,
        activeLockingScriptHex: this.activeLockingScriptHex,
        maxFeeSats: this.maxFeeSats
      },
      signal
    )

    const candidate = preparedReview.candidate
    const unsignedTransactionBytes = serializeTm1Draft02UnsignedTransaction(candidate)
    const unsignedTransactionAudit = auditTm1Draft02UnsignedTransaction({
      effectiveContent: preparedReview.effectiveContent,
      unsignedTransactionBytes
    })

    return {
      memoPreview,
      candidate,
      unsignedTransactionBytes,
      unsignedTransactionAudit,
      preparedReview
    }
  }

  /**
   * Step 5: Ejecutar la autorizacion dual (dual authorization).
   */
  async executeStep5DualAuthorizeAndSign(
    preparedReview: Tm1PreparedReview,
    signal?: AbortSignal
  ): Promise<{
    signedReview: Tm1SignedReview
    signingAuthorizationDecision: Tm1PublicationAuthorizationDecision
  }> {
    const signedReview = await this.orchestrator.authorizeAndSign(
      preparedReview.preparedId,
      signal
    )

    const signingAuthorizationDecision: Tm1PublicationAuthorizationDecision =
      Object.freeze({
        status: 'approved',
        authorizationId: signedReview.signingAuthorizationId,
        preparedId: preparedReview.preparedId,
        bindingHash: preparedReview.bindingHash
      })

    return {
      signedReview,
      signingAuthorizationDecision
    }
  }

  /**
   * Step 6: Ejecutar la reserva de recuperacion (recovery reservation) y
   * realizar exactamente un despacho (exactly-once dispatch) a traves del Orquestador.
   */
  async executeStep6ReserveRecoveryAndDispatch(
    preparedReview: Tm1PreparedReview,
    signedReview: Tm1SignedReview,
    signal?: AbortSignal
  ): Promise<{
    witnessReservationSnapshot: Tm1RollbackWitnessSnapshot
    dispatchIntentRecord: Tm1PublicationRecoveryRecord
    submissionReceipt: Tm1SubmissionReceipt
  }> {
    const slotId = `slot:${preparedReview.preparedId}`
    const storeId = `tm1-store:v1:${'44'.repeat(32)}`
    const logicalRoot = '00'.repeat(32)
    const nextLogicalRoot = '01'.repeat(32)
    const operationId = `op:${signedReview.signedId}`

    let enrolledSnapshot: Tm1RollbackWitnessSnapshot
    const existingRead = (await this.witness.read({
      slotId,
      signal
    })) as Tm1RollbackWitnessSnapshot | null

    if (!existingRead) {
      enrolledSnapshot = (await this.witness.enroll({
        slotId,
        storeId,
        logicalRoot,
        operationId: `enroll:${slotId}`,
        signal
      })) as Tm1RollbackWitnessSnapshot
    } else {
      enrolledSnapshot = existingRead
    }

    const witnessReservationSnapshot = (await this.witness.reserve({
      slotId,
      storeId,
      expectedStableGeneration: enrolledSnapshot.stable.generation,
      expectedStableLogicalRoot: enrolledSnapshot.stable.logicalRoot,
      expectedStableReceiptHash: enrolledSnapshot.stable.receiptHash,
      nextGeneration: enrolledSnapshot.stable.generation + 1,
      nextLogicalRoot,
      operationId,
      signal
    })) as Tm1RollbackWitnessSnapshot

    const publicationId = `pub:${preparedReview.preparedId}`
    const now = Date.now()

    const preDispatchRecord = parseTm1PublicationRecoveryRecord({
      schema: 'tonalli.tm1-publication-recovery',
      schemaVersion: 1,
      publicationId,
      revision: 1,
      ownerEpoch: 1,
      phase: 'preDispatch',
      preDispatchStage: 'broadcastAuthorizationConsumed',
      prepared: {
        preparedId: preparedReview.preparedId,
        bindingHash: preparedReview.bindingHash,
        preparedDigest: preparedReview.bindingHash
      },
      signed: {
        signedId: signedReview.signedId,
        txid: signedReview.txid,
        signedArtifactHash: signedReview.signedArtifactHash
      },
      signingAuthorization: {
        operationId: `sign-op:${preparedReview.preparedId}`,
        capabilityId: signedReview.signingAuthorizationId,
        contentHash: `sha256:${signedReview.bindingHash}` as `sha256:${string}`,
        expiresAt: now + 300_000,
        consumedAt: now,
        preparedId: preparedReview.preparedId,
        bindingHash: preparedReview.bindingHash
      },
      broadcastAuthorization: {
        operationId: `broadcast-op:${signedReview.signedId}`,
        capabilityId: `broadcast-cap:${signedReview.signedId}`,
        contentHash: `sha256:${signedReview.signedArtifactHash}` as `sha256:${string}`,
        expiresAt: now + 300_000,
        consumedAt: now,
        signedId: signedReview.signedId,
        txid: signedReview.txid,
        signedArtifactHash: signedReview.signedArtifactHash
      },
      dispatchIntent: null,
      transportAcknowledgement: null,
      lastObservation: null,
      terminal: null
    })

    await this.recoveryStore.create({ record: preDispatchRecord })

    const submissionId = `submission:${signedReview.signedId}`
    const outcomeUnknownRecord = parseTm1PublicationRecoveryRecord({
      ...preDispatchRecord,
      revision: 2,
      phase: 'outcomeUnknown',
      preDispatchStage: null,
      dispatchIntent: {
        submissionId,
        txid: signedReview.txid,
        signedArtifactHash: signedReview.signedArtifactHash,
        broadcastCapabilityId: preDispatchRecord.broadcastAuthorization!.capabilityId,
        committedAt: now
      }
    })

    await this.recoveryStore.commitDispatchIntent({
      publicationId,
      expectedRevision: 1,
      expectedOwnerEpoch: 1,
      nextRecord: outcomeUnknownRecord
    })

    const initialDispatchCount = this.dispatchCalls
    this.plannedSubmissionId = submissionId

    const submissionReceipt = await this.orchestrator.approveAndBroadcast(
      signedReview.signedId,
      signal
    )

    if (this.dispatchCalls !== initialDispatchCount + 1) {
      throw new Error(
        `Exactly-once dispatch violation: expected 1 dispatch, observed ${this.dispatchCalls - initialDispatchCount}`
      )
    }

    let duplicateAttemptBlocked = false
    try {
      await this.orchestrator.approveAndBroadcast(signedReview.signedId, signal)
    } catch (error) {
      if (error instanceof Tm1PublicationError && error.code === 'INVALID_STATE') {
        duplicateAttemptBlocked = true
      }
    }

    if (!duplicateAttemptBlocked) {
      throw new Error(
        'Exactly-once dispatch violation: secondary dispatch was not rejected with INVALID_STATE'
      )
    }

    return {
      witnessReservationSnapshot,
      dispatchIntentRecord: outcomeUnknownRecord,
      submissionReceipt
    }
  }

  /**
   * Step 7: Comprobar el estado final de exito.
   */
  async executeStep7VerifyFinalSuccess(
    preparedReview: Tm1PreparedReview,
    signedReview: Tm1SignedReview,
    submissionReceipt: Tm1SubmissionReceipt,
    witnessReservationSnapshot: Tm1RollbackWitnessSnapshot,
    signal?: AbortSignal
  ): Promise<{
    transportAcknowledgedRecord: Tm1PublicationRecoveryRecord
    finalOrchestratorState: Tm1PublicationState
    confirmedReceipt?: Tm1Confirmation
  }> {
    const publicationId = `pub:${preparedReview.preparedId}`
    const storeId = `tm1-store:v1:${'44'.repeat(32)}`
    const slotId = `slot:${preparedReview.preparedId}`

    const transportAcknowledgedRecord =
      (await this.recoveryStore.commitTransportAcknowledgement({
        publicationId,
        expectedRevision: 2,
        expectedOwnerEpoch: 1,
        acknowledgement: {
          submissionId: submissionReceipt.submissionId,
          signedId: signedReview.signedId,
          txid: submissionReceipt.txid,
          signedArtifactHash: signedReview.signedArtifactHash,
          disposition: 'accepted',
          acknowledgedAt: Date.now()
        }
      })) as Tm1PublicationRecoveryRecord

    if (transportAcknowledgedRecord.phase !== 'submittedObserved') {
      throw new Error(
        `Recovery record expected phase 'submittedObserved', got '${transportAcknowledgedRecord.phase}'`
      )
    }

    const finalOrchestratorState = this.orchestrator.getState()
    if (finalOrchestratorState.status !== 'submitted') {
      throw new Error(
        `Final orchestrator state expected 'submitted', got '${finalOrchestratorState.status}'`
      )
    }

    if (finalOrchestratorState.receipt.txid !== submissionReceipt.txid) {
      throw new Error('Orchestrator receipt txid does not match submission receipt')
    }

    if (witnessReservationSnapshot.pending) {
      await this.witness.finalize({
        slotId,
        storeId,
        generation: witnessReservationSnapshot.pending.generation,
        logicalRoot: witnessReservationSnapshot.pending.logicalRoot,
        pendingReceiptHash: witnessReservationSnapshot.pending.receiptHash,
        operationId: witnessReservationSnapshot.pending.operationId,
        signal
      })
    }

    return {
      transportAcknowledgedRecord,
      finalOrchestratorState
    }
  }

  /**
   * Executes all 7 steps of the TM1 Programmatic E2E Pipeline in strict sequence.
   */
  async executePipeline(signal?: AbortSignal): Promise<Tm1ProgrammaticE2eResult> {
    // Step 1: Resolve simulated alias & observe ownership
    const evidenceToken = await this.executeStep1VerifyAlias(signal)

    // Step 2: Produce VerifiedAliasOwnershipEvidence
    const verifiedAliasSnapshot = this.executeStep2ProduceEvidence(evidenceToken)

    // Step 3: Pass verified evidence to authorizer
    const aliasPublicationAuthorization =
      this.executeStep3AuthorizePublication(evidenceToken)

    // Step 4: Prepare canonical TM1 memo & unsigned tx
    const {
      memoPreview,
      candidate,
      unsignedTransactionBytes,
      unsignedTransactionAudit,
      preparedReview
    } = await this.executeStep4PrepareMemoAndUnsignedTx(signal)

    // Step 5: Execute dual authorization
    const { signedReview, signingAuthorizationDecision } =
      await this.executeStep5DualAuthorizeAndSign(preparedReview, signal)

    // Step 6: Recovery reservation & exactly-once dispatch
    const {
      witnessReservationSnapshot,
      dispatchIntentRecord,
      submissionReceipt
    } = await this.executeStep6ReserveRecoveryAndDispatch(
      preparedReview,
      signedReview,
      signal
    )

    // Step 7: Final success verification
    const { transportAcknowledgedRecord, finalOrchestratorState } =
      await this.executeStep7VerifyFinalSuccess(
        preparedReview,
        signedReview,
        submissionReceipt,
        witnessReservationSnapshot,
        signal
      )

    return Object.freeze({
      success: true,
      alias: this.alias,
      ownerAddress: this.ownerAddress,
      txid: submissionReceipt.txid,
      submissionId: submissionReceipt.submissionId,
      steps: Object.freeze({
        verifiedAliasEvidenceToken: evidenceToken,
        verifiedAliasSnapshot,
        aliasPublicationAuthorization,
        memoPreview,
        candidate,
        unsignedTransactionBytes,
        unsignedTransactionAudit,
        preparedReview,
        signingAuthorizationDecision,
        signedReview,
        witnessReservationSnapshot,
        dispatchIntentRecord,
        submissionReceipt,
        dispatchCount: this.getDispatchCount(),
        transportAcknowledgedRecord,
        finalOrchestratorState
      })
    })
  }
}

export function createTm1RegtestE2eHarness(
  options: Tm1ProgrammaticE2eOptions = {}
): Tm1RegtestE2eHarness {
  return new Tm1RegtestE2eHarness(options)
}

export async function executeTm1ProgrammaticE2ePipeline(
  options: Tm1ProgrammaticE2eOptions = {}
): Promise<Tm1ProgrammaticE2eResult> {
  const harness = createTm1RegtestE2eHarness(options)
  return harness.executePipeline(options.signal)
}
