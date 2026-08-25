import { describe, expect, it } from 'vitest'
import { createTm1InMemoryRollbackWitness } from './tm1InMemoryRollbackWitness'
import {
  Tm1RollbackWitnessError,
  parseTm1RollbackWitnessRecord,
  parseTm1RollbackWitnessSnapshot
} from './tm1RollbackWitness'

const SLOT = 'account:device:tm1'
const STORE = `tm1-store:v1:${'a'.repeat(64)}`
const ROOT_0 = 'b'.repeat(64)
const ROOT_1 = 'c'.repeat(64)
const OP_0 = 'operation:enroll'
const OP_1 = 'operation:mutation:one'

describe('TM1 rollback witness protocol', () => {
  it('explicitly enrolls one canonical store identity', async () => {
    const witness = createTm1InMemoryRollbackWitness()
    const enrolled = parseTm1RollbackWitnessSnapshot(await witness.enroll({
      slotId: SLOT,
      storeId: STORE,
      logicalRoot: ROOT_0,
      operationId: OP_0
    }))

    expect(enrolled.stable).toMatchObject({
      slotId: SLOT,
      storeId: STORE,
      generation: 0,
      logicalRoot: ROOT_0,
      previousStableReceiptHash: null,
      operationId: OP_0,
      state: 'stable'
    })
    expect(enrolled.pending).toBeNull()
    expect(await witness.verifyRecord(enrolled.stable)).toBe(true)
    expect(Object.isFrozen(enrolled)).toBe(true)
    expect(Object.isFrozen(enrolled.stable)).toBe(true)
  })

  it('does not treat an absent slot as permission to enroll on read', async () => {
    const witness = createTm1InMemoryRollbackWitness()
    expect(await witness.read({ slotId: SLOT })).toBeNull()
    expect(witness.inspect(SLOT)).toBeNull()
  })

  it('rejects silent re-enrollment and a substituted store identity', async () => {
    const witness = await enrolledWitness()
    await expect(witness.enroll({
      slotId: SLOT,
      storeId: `tm1-store:v1:${'d'.repeat(64)}`,
      logicalRoot: ROOT_0,
      operationId: 'operation:replace'
    })).rejects.toMatchObject({ code: 'WITNESS_ALREADY_ENROLLED' })
  })

  it('reserves exactly one CAS successor and finalizes that exact pending entry', async () => {
    const witness = await enrolledWitness()
    const stable = parseTm1RollbackWitnessSnapshot(
      await witness.read({ slotId: SLOT })
    ).stable
    const reserved = parseTm1RollbackWitnessSnapshot(await witness.reserve({
      slotId: SLOT,
      storeId: STORE,
      expectedStableGeneration: 0,
      expectedStableLogicalRoot: ROOT_0,
      expectedStableReceiptHash: stable.receiptHash,
      nextGeneration: 1,
      nextLogicalRoot: ROOT_1,
      operationId: OP_1
    }))

    expect(reserved.stable).toEqual(stable)
    expect(reserved.pending).toMatchObject({
      generation: 1,
      logicalRoot: ROOT_1,
      previousStableReceiptHash: stable.receiptHash,
      operationId: OP_1,
      state: 'pending'
    })
    expect(await witness.verifyRecord(reserved.pending!)).toBe(true)

    const finalized = parseTm1RollbackWitnessSnapshot(await witness.finalize({
      slotId: SLOT,
      storeId: STORE,
      generation: 1,
      logicalRoot: ROOT_1,
      operationId: OP_1,
      pendingReceiptHash: reserved.pending!.receiptHash
    }))
    expect(finalized.pending).toBeNull()
    expect(finalized.stable).toMatchObject({
      generation: 1,
      logicalRoot: ROOT_1,
      previousStableReceiptHash: stable.receiptHash,
      state: 'stable'
    })
    expect(finalized.stable.receiptHash).not.toBe(reserved.pending!.receiptHash)
  })

  it('allows only one winner in a simultaneous reserve CAS race', async () => {
    const witness = await enrolledWitness()
    const stable = parseTm1RollbackWitnessSnapshot(
      await witness.read({ slotId: SLOT })
    ).stable
    const request = {
      slotId: SLOT,
      storeId: STORE,
      expectedStableGeneration: 0,
      expectedStableLogicalRoot: ROOT_0,
      expectedStableReceiptHash: stable.receiptHash,
      nextGeneration: 1,
      nextLogicalRoot: ROOT_1,
      operationId: OP_1
    }

    const results = await Promise.allSettled([
      witness.reserve(request),
      witness.reserve(request)
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({
      reason: { code: 'WITNESS_CONFLICT' }
    })
  })

  it('rejects stale stable-head CAS and wrong pending finalization', async () => {
    const witness = await enrolledWitness()
    const stable = parseTm1RollbackWitnessSnapshot(
      await witness.read({ slotId: SLOT })
    ).stable
    await expect(witness.reserve({
      slotId: SLOT,
      storeId: STORE,
      expectedStableGeneration: 0,
      expectedStableLogicalRoot: ROOT_0,
      expectedStableReceiptHash: 'd'.repeat(64),
      nextGeneration: 1,
      nextLogicalRoot: ROOT_1,
      operationId: OP_1
    })).rejects.toMatchObject({ code: 'WITNESS_CONFLICT' })

    const reserved = parseTm1RollbackWitnessSnapshot(await witness.reserve({
      slotId: SLOT,
      storeId: STORE,
      expectedStableGeneration: 0,
      expectedStableLogicalRoot: ROOT_0,
      expectedStableReceiptHash: stable.receiptHash,
      nextGeneration: 1,
      nextLogicalRoot: ROOT_1,
      operationId: OP_1
    }))
    await expect(witness.finalize({
      slotId: SLOT,
      storeId: STORE,
      generation: 1,
      logicalRoot: ROOT_1,
      operationId: OP_1,
      pendingReceiptHash: 'e'.repeat(64)
    })).rejects.toMatchObject({ code: 'WITNESS_CONFLICT' })
    expect(parseTm1RollbackWitnessSnapshot(
      await witness.read({ slotId: SLOT })
    )).toEqual(reserved)
  })

  it('fails closed when the independent witness is unavailable', async () => {
    const witness = await enrolledWitness()
    witness.setAvailable(false)
    await expect(witness.read({ slotId: SLOT })).rejects.toMatchObject({
      code: 'WITNESS_UNAVAILABLE'
    })
    await expect(witness.verifyRecord(parseTm1RollbackWitnessSnapshot(
      witness.inspect(SLOT)
    ).stable)).rejects.toMatchObject({ code: 'WITNESS_UNAVAILABLE' })
  })

  it('observes an already-aborted request without mutating witness state', async () => {
    const witness = await enrolledWitness()
    const before = witness.inspect(SLOT)
    const controller = new AbortController()
    controller.abort()
    await expect(witness.reserve({
      slotId: SLOT,
      storeId: STORE,
      expectedStableGeneration: 0,
      expectedStableLogicalRoot: ROOT_0,
      expectedStableReceiptHash: before!.stable.receiptHash,
      nextGeneration: 1,
      nextLogicalRoot: ROOT_1,
      operationId: OP_1,
      signal: controller.signal
    })).rejects.toMatchObject({ code: 'WITNESS_UNAVAILABLE' })
    expect(witness.inspect(SLOT)).toEqual(before)
  })

  it('rejects malformed, accessor-backed and extra-key records', () => {
    const base = validRecord()
    expect(() => parseTm1RollbackWitnessRecord({
      ...base,
      extra: true
    })).toThrow(Tm1RollbackWitnessError)
    expect(() => parseTm1RollbackWitnessRecord({
      ...base,
      logicalRoot: 'not-a-hash'
    })).toThrow(Tm1RollbackWitnessError)
    expect(() => parseTm1RollbackWitnessRecord(Object.defineProperty({
      ...base
    }, 'logicalRoot', { get: () => ROOT_0 }))).toThrow(Tm1RollbackWitnessError)
  })

  it('rejects incoherent pending chains before receipt verification', () => {
    const stable = validRecord()
    expect(() => parseTm1RollbackWitnessSnapshot({
      stable,
      pending: {
        ...stable,
        generation: 1,
        state: 'pending',
        previousStableReceiptHash: 'f'.repeat(64)
      }
    })).toThrow(Tm1RollbackWitnessError)
  })

  it('does not authenticate a record modified after issuance', async () => {
    const witness = await enrolledWitness()
    const stable = parseTm1RollbackWitnessSnapshot(
      await witness.read({ slotId: SLOT })
    ).stable
    const modified = parseTm1RollbackWitnessRecord({
      ...stable,
      logicalRoot: ROOT_1
    })
    expect(await witness.verifyRecord(modified)).toBe(false)
  })
})

async function enrolledWitness() {
  const witness = createTm1InMemoryRollbackWitness()
  await witness.enroll({
    slotId: SLOT,
    storeId: STORE,
    logicalRoot: ROOT_0,
    operationId: OP_0
  })
  return witness
}

function validRecord() {
  return {
    protocol: 'tonalli.tm1-rollback-witness',
    protocolVersion: 1,
    slotId: SLOT,
    storeId: STORE,
    generation: 0,
    logicalRoot: ROOT_0,
    previousStableReceiptHash: null,
    operationId: OP_0,
    state: 'stable',
    witnessKeyId: 'tm1-test-witness-key:v1',
    receiptHash: '1'.repeat(64),
    authenticatedReceipt: 'receipt'
  }
}
