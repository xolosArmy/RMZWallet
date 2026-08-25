import {
  TM1_ROLLBACK_WITNESS_PROTOCOL,
  TM1_ROLLBACK_WITNESS_PROTOCOL_VERSION,
  Tm1RollbackWitnessError,
  parseTm1RollbackWitnessRecord,
  parseTm1RollbackWitnessSnapshot,
  snapshotTm1RollbackWitnessEnrollment,
  snapshotTm1RollbackWitnessFinalization,
  snapshotTm1RollbackWitnessRead,
  snapshotTm1RollbackWitnessReservation,
  type Tm1RollbackWitness,
  type Tm1RollbackWitnessEnrollment,
  type Tm1RollbackWitnessFinalization,
  type Tm1RollbackWitnessRead,
  type Tm1RollbackWitnessRecord,
  type Tm1RollbackWitnessRecordState,
  type Tm1RollbackWitnessReservation,
  type Tm1RollbackWitnessSnapshot
} from './tm1RollbackWitness'

const DEFAULT_TEST_KEY_ID = 'tm1-test-witness-key:v1'

/**
 * Deterministic adversarial-test double. Its receipts are authenticated only
 * against this object's private issued-record registry and are not suitable
 * for production or persistence.
 */
export class Tm1InMemoryRollbackWitness implements Tm1RollbackWitness {
  private readonly slots = new Map<string, Tm1RollbackWitnessSnapshot>()
  private readonly issued = new Map<string, string>()
  private readonly witnessKeyId: string
  private receiptSequence = 0
  private available = true

  constructor(witnessKeyId = DEFAULT_TEST_KEY_ID) {
    if (typeof witnessKeyId !== 'string' || witnessKeyId.length === 0) {
      throw new Tm1RollbackWitnessError('INVALID_WITNESS_INPUT')
    }
    this.witnessKeyId = witnessKeyId
  }

  async read(input: Tm1RollbackWitnessRead): Promise<unknown | null> {
    const request = snapshotTm1RollbackWitnessRead(input)
    this.assertAvailable(request.signal)
    return this.slots.get(request.slotId) ?? null
  }

  async enroll(input: Tm1RollbackWitnessEnrollment): Promise<unknown> {
    const request = snapshotTm1RollbackWitnessEnrollment(input)
    this.assertAvailable(request.signal)
    if (this.slots.has(request.slotId)) {
      throw new Tm1RollbackWitnessError('WITNESS_ALREADY_ENROLLED')
    }
    const stable = this.issueRecord({
      slotId: request.slotId,
      storeId: request.storeId,
      generation: 0,
      logicalRoot: request.logicalRoot,
      previousStableReceiptHash: null,
      operationId: request.operationId,
      state: 'stable'
    })
    const snapshot = parseTm1RollbackWitnessSnapshot({ stable, pending: null })
    this.slots.set(request.slotId, snapshot)
    return snapshot
  }

  async reserve(input: Tm1RollbackWitnessReservation): Promise<unknown> {
    const request = snapshotTm1RollbackWitnessReservation(input)
    this.assertAvailable(request.signal)
    const current = this.slots.get(request.slotId)
    if (current === undefined) {
      throw new Tm1RollbackWitnessError('WITNESS_NOT_ENROLLED')
    }
    if (
      current.pending !== null ||
      current.stable.storeId !== request.storeId ||
      current.stable.generation !== request.expectedStableGeneration ||
      current.stable.logicalRoot !== request.expectedStableLogicalRoot ||
      current.stable.receiptHash !== request.expectedStableReceiptHash ||
      request.nextGeneration !== current.stable.generation + 1
    ) throw new Tm1RollbackWitnessError('WITNESS_CONFLICT')
    const pending = this.issueRecord({
      slotId: request.slotId,
      storeId: request.storeId,
      generation: request.nextGeneration,
      logicalRoot: request.nextLogicalRoot,
      previousStableReceiptHash: current.stable.receiptHash,
      operationId: request.operationId,
      state: 'pending'
    })
    const snapshot = parseTm1RollbackWitnessSnapshot({
      stable: current.stable,
      pending
    })
    this.slots.set(request.slotId, snapshot)
    return snapshot
  }

  async finalize(input: Tm1RollbackWitnessFinalization): Promise<unknown> {
    const request = snapshotTm1RollbackWitnessFinalization(input)
    this.assertAvailable(request.signal)
    const current = this.slots.get(request.slotId)
    if (current === undefined) {
      throw new Tm1RollbackWitnessError('WITNESS_NOT_ENROLLED')
    }
    const pending = current.pending
    if (
      pending === null ||
      pending.storeId !== request.storeId ||
      pending.generation !== request.generation ||
      pending.logicalRoot !== request.logicalRoot ||
      pending.operationId !== request.operationId ||
      pending.receiptHash !== request.pendingReceiptHash
    ) throw new Tm1RollbackWitnessError('WITNESS_CONFLICT')
    const stable = this.issueRecord({
      slotId: pending.slotId,
      storeId: pending.storeId,
      generation: pending.generation,
      logicalRoot: pending.logicalRoot,
      previousStableReceiptHash: pending.previousStableReceiptHash,
      operationId: pending.operationId,
      state: 'stable'
    })
    const snapshot = parseTm1RollbackWitnessSnapshot({ stable, pending: null })
    this.slots.set(request.slotId, snapshot)
    return snapshot
  }

  async verifyRecord(recordValue: Tm1RollbackWitnessRecord): Promise<boolean> {
    this.assertAvailable()
    let record: Tm1RollbackWitnessRecord
    try {
      record = parseTm1RollbackWitnessRecord(recordValue)
    } catch {
      return false
    }
    return this.issued.get(record.receiptHash) === canonicalRecord(record)
  }

  /** Test-only availability control. */
  setAvailable(available: boolean): void {
    this.available = available
  }

  /** Test-only immutable inspection; this does not mutate witness state. */
  inspect(slotId: string): Tm1RollbackWitnessSnapshot | null {
    const snapshot = this.slots.get(slotId)
    return snapshot ?? null
  }

  private issueRecord(input: Readonly<{
    slotId: string
    storeId: string
    generation: number
    logicalRoot: string
    previousStableReceiptHash: string | null
    operationId: string
    state: Tm1RollbackWitnessRecordState
  }>): Tm1RollbackWitnessRecord {
    this.receiptSequence += 1
    const receiptHash = this.receiptSequence.toString(16).padStart(64, '0')
    const authenticatedReceipt = [
      'tm1-test-receipt:v1',
      this.receiptSequence,
      input.slotId,
      input.storeId,
      input.generation,
      input.logicalRoot,
      input.previousStableReceiptHash ?? 'genesis',
      input.operationId,
      input.state,
      this.witnessKeyId
    ].join('|')
    const record = parseTm1RollbackWitnessRecord({
      protocol: TM1_ROLLBACK_WITNESS_PROTOCOL,
      protocolVersion: TM1_ROLLBACK_WITNESS_PROTOCOL_VERSION,
      ...input,
      witnessKeyId: this.witnessKeyId,
      receiptHash,
      authenticatedReceipt
    })
    this.issued.set(receiptHash, canonicalRecord(record))
    return record
  }

  private assertAvailable(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new Tm1RollbackWitnessError('WITNESS_UNAVAILABLE')
    }
    if (!this.available) {
      throw new Tm1RollbackWitnessError('WITNESS_UNAVAILABLE')
    }
  }
}

export function createTm1InMemoryRollbackWitness(
  witnessKeyId?: string
): Tm1InMemoryRollbackWitness {
  return new Tm1InMemoryRollbackWitness(witnessKeyId)
}

function canonicalRecord(record: Tm1RollbackWitnessRecord): string {
  return JSON.stringify(record)
}
