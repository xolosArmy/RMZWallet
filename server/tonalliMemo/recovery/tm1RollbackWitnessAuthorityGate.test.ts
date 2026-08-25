import { chmodSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createTm1InMemoryRollbackWitness } from '../../../src/integrations/tonalliMemo/recovery/tm1InMemoryRollbackWitness'
import {
  parseTm1RollbackWitnessRecord,
  parseTm1RollbackWitnessSnapshot,
  type Tm1RollbackWitness,
  type Tm1RollbackWitnessSnapshot
} from '../../../src/integrations/tonalliMemo/recovery/tm1RollbackWitness'
import {
  establishTm1RollbackWitnessFreshness,
  provisionTm1RollbackWitness
} from './tm1RollbackWitnessAuthorityGate'
import {
  createTm1SqlitePublicationRecoveryStore,
  type Tm1SqlitePublicationRecoveryStore
} from './tm1SqlitePublicationRecoveryStore'
const SLOT = 'account:device:tm1'
const STORE = `tm1-store:v1:${'a'.repeat(64)}`
const OTHER_STORE = `tm1-store:v1:${'b'.repeat(64)}`
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('TM1 rollback witness authority gate', () => {
  test('explicitly provisions one store and establishes same-store restart freshness', async () => {
    const { store, databasePath } = harness()
    const witness = createTm1InMemoryRollbackWitness()
    const provisioned = await provision(store, witness)
    expect(provisioned).toMatchObject({
      slotId: SLOT,
      storeId: STORE,
      generation: 0
    })
    expect(Object.isFrozen(provisioned)).toBe(true)
    store.close()

    const restarted = openStore(databasePath)
    await expect(establishTm1RollbackWitnessFreshness(
      { store: restarted, witness },
      { slotId: SLOT }
    )).resolves.toEqual(provisioned)
    restarted.close()
  })

  test('fails closed when no production witness is configured', async () => {
    const { store } = harness()
    await expect(establishTm1RollbackWitnessFreshness(
      { store },
      { slotId: SLOT }
    )).rejects.toMatchObject({ code: 'WITNESS_NOT_CONFIGURED' })
    expect(store.inspectWitnessBinding()).toBeNull()
    store.close()
  })

  test('does not silently enroll an absent witness during ordinary startup', async () => {
    const { store } = harness()
    const witness = createTm1InMemoryRollbackWitness()
    await expect(establishTm1RollbackWitnessFreshness(
      { store, witness },
      { slotId: SLOT }
    )).rejects.toMatchObject({ code: 'WITNESS_NOT_ENROLLED' })
    expect(store.inspectWitnessBinding()).toBeNull()
    expect(witness.inspect(SLOT)).toBeNull()
    store.close()
  })

  test('requires administrative recovery after remote enrollment but failed local commit', async () => {
    const { store } = harness()
    const witness = createTm1InMemoryRollbackWitness()
    const brokenStore = {
      inspectWitnessBinding: store.inspectWitnessBinding.bind(store),
      computeEnrollmentLogicalRoot: store.computeEnrollmentLogicalRoot.bind(store),
      enrollWitnessBinding: () => {
        throw new Error('simulated local commit failure')
      }
    }
    await expect(provisionTm1RollbackWitness(
      { store: brokenStore, witness },
      { slotId: SLOT, storeId: STORE, operationId: 'operation:enroll' }
    )).rejects.toMatchObject({ code: 'ENROLLMENT_RECOVERY_REQUIRED' })
    expect(store.inspectWitnessBinding()).toBeNull()
    expect(witness.inspect(SLOT)?.stable.storeId).toBe(STORE)

    await expect(establishTm1RollbackWitnessFreshness(
      { store, witness },
      { slotId: SLOT }
    )).rejects.toMatchObject({ code: 'ENROLLMENT_RECOVERY_REQUIRED' })
    store.close()
  })

  test('rejects a different local storeId substituted into the authenticated slot', async () => {
    const canonical = harness()
    const witness = createTm1InMemoryRollbackWitness()
    await provision(canonical.store, witness)

    const substituted = harness()
    const root = substituted.store.computeEnrollmentLogicalRoot({
      slotId: SLOT,
      storeId: OTHER_STORE
    })
    substituted.store.enrollWitnessBinding({
      slotId: SLOT,
      storeId: OTHER_STORE,
      logicalRoot: root
    })
    await expect(establishTm1RollbackWitnessFreshness(
      { store: substituted.store, witness },
      { slotId: SLOT }
    )).rejects.toMatchObject({ code: 'STORE_IDENTITY_MISMATCH' })
    canonical.store.close()
    substituted.store.close()
  })

  test('finalizes matching pending plus committed DB without signer or transport', async () => {
    const { store } = harness()
    const witness = createTm1InMemoryRollbackWitness()
    await provision(store, witness)
    const pending = await reserveNext(store, witness)
    const beforeFinalizeReceipt = pending.pending!.receiptHash
    store.commitReservedWitnessBinding({
      expectedGeneration: 0,
      expectedLogicalRoot: pending.stable.logicalRoot,
      pendingRecord: pending.pending!
    })

    const freshness = await establishTm1RollbackWitnessFreshness(
      { store, witness },
      { slotId: SLOT }
    )
    expect(freshness).toMatchObject({
      generation: 1,
      logicalRoot: pending.pending!.logicalRoot
    })
    expect(freshness.stableReceiptHash).not.toBe(beforeFinalizeReceipt)
    expect(witness.inspect(SLOT)?.pending).toBeNull()
    expect(witness.inspect(SLOT)?.stable.generation).toBe(1)
    store.close()
  })

  test('quarantines pending plus old DB and never cancels the reservation', async () => {
    const { store } = harness()
    const witness = createTm1InMemoryRollbackWitness()
    await provision(store, witness)
    const pending = await reserveNext(store, witness)

    await expect(establishTm1RollbackWitnessFreshness(
      { store, witness },
      { slotId: SLOT }
    )).rejects.toMatchObject({ code: 'WITNESS_PENDING_QUARANTINE' })
    expect(witness.inspect(SLOT)).toEqual(pending)
    expect(store.inspectWitnessBinding()?.generation).toBe(0)
    store.close()
  })

  test('detects an old internally valid DB against a newer stable witness', async () => {
    const current = harness()
    const witness = createTm1InMemoryRollbackWitness()
    await provision(current.store, witness)
    current.store.close()
    const stalePath = cloneDatabase(current.databasePath)

    const live = openStore(current.databasePath)
    const pending = await reserveNext(live, witness)
    live.commitReservedWitnessBinding({
      expectedGeneration: 0,
      expectedLogicalRoot: pending.stable.logicalRoot,
      pendingRecord: pending.pending!
    })
    await establishTm1RollbackWitnessFreshness(
      { store: live, witness },
      { slotId: SLOT }
    )
    live.close()

    const stale = openStore(stalePath)
    await expect(establishTm1RollbackWitnessFreshness(
      { store: stale, witness },
      { slotId: SLOT }
    )).rejects.toMatchObject({ code: 'ROLLBACK_DETECTED' })
    stale.close()
  })

  test('rejects a coherent local DB ahead of stable witness without pending', async () => {
    const { store } = harness()
    const witness = createTm1InMemoryRollbackWitness()
    const enrolled = await provision(store, witness)
    const root1 = store.computeWitnessLogicalRoot(1)
    store.commitReservedWitnessBinding({
      expectedGeneration: 0,
      expectedLogicalRoot: enrolled.logicalRoot,
      pendingRecord: fabricatedPending(enrolled, root1)
    })

    await expect(establishTm1RollbackWitnessFreshness(
      { store, witness },
      { slotId: SLOT }
    )).rejects.toMatchObject({ code: 'LOCAL_STATE_AHEAD_OF_WITNESS' })
    store.close()
  })

  test('quarantines a pending root that differs from the coherent committed DB', async () => {
    const { store } = harness()
    const witness = createTm1InMemoryRollbackWitness()
    const enrolled = await provision(store, witness)
    const localRoot1 = store.computeWitnessLogicalRoot(1)
    store.commitReservedWitnessBinding({
      expectedGeneration: 0,
      expectedLogicalRoot: enrolled.logicalRoot,
      pendingRecord: fabricatedPending(enrolled, localRoot1)
    })
    const stable = parseTm1RollbackWitnessSnapshot(
      await witness.read({ slotId: SLOT })
    ).stable
    await witness.reserve({
      slotId: SLOT,
      storeId: STORE,
      expectedStableGeneration: 0,
      expectedStableLogicalRoot: stable.logicalRoot,
      expectedStableReceiptHash: stable.receiptHash,
      nextGeneration: 1,
      nextLogicalRoot: 'd'.repeat(64),
      operationId: 'operation:mismatch'
    })

    await expect(establishTm1RollbackWitnessFreshness(
      { store, witness },
      { slotId: SLOT }
    )).rejects.toMatchObject({ code: 'WITNESS_STATE_MISMATCH' })
    store.close()
  })

  test('rejects missing, unavailable and unverifiable remote witness state', async () => {
    const { store } = harness()
    const witness = createTm1InMemoryRollbackWitness()
    await provision(store, witness)

    const missing = createTm1InMemoryRollbackWitness()
    await expect(establishTm1RollbackWitnessFreshness(
      { store, witness: missing },
      { slotId: SLOT }
    )).rejects.toMatchObject({ code: 'WITNESS_NOT_ENROLLED' })

    witness.setAvailable(false)
    await expect(establishTm1RollbackWitnessFreshness(
      { store, witness },
      { slotId: SLOT }
    )).rejects.toMatchObject({ code: 'WITNESS_UNAVAILABLE' })
    witness.setAvailable(true)

    const unverifiable = proxyWitness(witness, { verifyRecord: async () => false })
    await expect(establishTm1RollbackWitnessFreshness(
      { store, witness: unverifiable },
      { slotId: SLOT }
    )).rejects.toMatchObject({ code: 'WITNESS_UNVERIFIABLE' })
    store.close()
  })

  test('rejects replay of an older valid receipt after local generation advances', async () => {
    const { store } = harness()
    const witness = createTm1InMemoryRollbackWitness()
    await provision(store, witness)
    const oldSnapshot = parseTm1RollbackWitnessSnapshot(
      await witness.read({ slotId: SLOT })
    )
    const pending = await reserveNext(store, witness)
    store.commitReservedWitnessBinding({
      expectedGeneration: 0,
      expectedLogicalRoot: pending.stable.logicalRoot,
      pendingRecord: pending.pending!
    })
    await establishTm1RollbackWitnessFreshness({ store, witness }, { slotId: SLOT })

    const replay = proxyWitness(witness, { read: async () => oldSnapshot })
    await expect(establishTm1RollbackWitnessFreshness(
      { store, witness: replay },
      { slotId: SLOT }
    )).rejects.toMatchObject({ code: 'LOCAL_STATE_AHEAD_OF_WITNESS' })
    store.close()
  })

  test('allows inspection of a current clone but leaves successor authority to remote CAS', async () => {
    const original = harness()
    const witness = createTm1InMemoryRollbackWitness()
    await provision(original.store, witness)
    original.store.close()
    const clonePath = cloneDatabase(original.databasePath)
    const first = openStore(original.databasePath)
    const clone = openStore(clonePath)

    const [firstFreshness, cloneFreshness] = await Promise.all([
      establishTm1RollbackWitnessFreshness({ store: first, witness }, { slotId: SLOT }),
      establishTm1RollbackWitnessFreshness({ store: clone, witness }, { slotId: SLOT })
    ])
    expect(firstFreshness).toEqual(cloneFreshness)

    const root1 = first.computeWitnessLogicalRoot(1)
    const request = {
      slotId: SLOT,
      storeId: STORE,
      expectedStableGeneration: 0,
      expectedStableLogicalRoot: firstFreshness.logicalRoot,
      expectedStableReceiptHash: firstFreshness.stableReceiptHash,
      nextGeneration: 1,
      nextLogicalRoot: root1,
      operationId: 'operation:controller-race'
    }
    const results = await Promise.allSettled([
      witness.reserve(request),
      witness.reserve(request)
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    first.close()
    clone.close()
  })

  test('aborts before any witness or local enrollment mutation', async () => {
    const { store } = harness()
    const witness = createTm1InMemoryRollbackWitness()
    const abort = new AbortController()
    abort.abort()
    await expect(provisionTm1RollbackWitness(
      { store, witness },
      {
        slotId: SLOT,
        storeId: STORE,
        operationId: 'operation:enroll',
        signal: abort.signal
      }
    )).rejects.toMatchObject({ code: 'AUTHORITY_GATE_ABORTED' })
    expect(witness.inspect(SLOT)).toBeNull()
    expect(store.inspectWitnessBinding()).toBeNull()
    store.close()
  })
})

async function provision(
  store: Tm1SqlitePublicationRecoveryStore,
  witness: Tm1RollbackWitness
) {
  return provisionTm1RollbackWitness(
    { store, witness },
    { slotId: SLOT, storeId: STORE, operationId: 'operation:enroll' }
  )
}

async function reserveNext(
  store: Tm1SqlitePublicationRecoveryStore,
  witness: Tm1RollbackWitness
): Promise<Tm1RollbackWitnessSnapshot> {
  const current = parseTm1RollbackWitnessSnapshot(await witness.read({ slotId: SLOT }))
  const nextRoot = store.computeWitnessLogicalRoot(current.stable.generation + 1)
  return parseTm1RollbackWitnessSnapshot(await witness.reserve({
    slotId: SLOT,
    storeId: STORE,
    expectedStableGeneration: current.stable.generation,
    expectedStableLogicalRoot: current.stable.logicalRoot,
    expectedStableReceiptHash: current.stable.receiptHash,
    nextGeneration: current.stable.generation + 1,
    nextLogicalRoot: nextRoot,
    operationId: `operation:generation:${current.stable.generation + 1}`
  }))
}

function fabricatedPending(
  stable: Readonly<{
    slotId: string
    storeId: string
    generation: number
    logicalRoot: string
    stableReceiptHash: string
    witnessKeyId: string
  }>,
  logicalRoot: string
) {
  return parseTm1RollbackWitnessRecord({
    protocol: 'tonalli.tm1-rollback-witness',
    protocolVersion: 1,
    slotId: stable.slotId,
    storeId: stable.storeId,
    generation: stable.generation + 1,
    logicalRoot,
    previousStableReceiptHash: stable.stableReceiptHash,
    operationId: 'operation:fabricated-local-crash-state',
    state: 'pending',
    witnessKeyId: stable.witnessKeyId,
    receiptHash: 'f'.repeat(64),
    authenticatedReceipt: 'local-evidence-is-not-remote-authority'
  })
}

function proxyWitness(
  base: Tm1RollbackWitness,
  overrides: Partial<Tm1RollbackWitness>
): Tm1RollbackWitness {
  return {
    read: overrides.read?.bind(overrides) ?? base.read.bind(base),
    enroll: overrides.enroll?.bind(overrides) ?? base.enroll.bind(base),
    reserve: overrides.reserve?.bind(overrides) ?? base.reserve.bind(base),
    finalize: overrides.finalize?.bind(overrides) ?? base.finalize.bind(base),
    verifyRecord: overrides.verifyRecord?.bind(overrides) ?? base.verifyRecord.bind(base)
  }
}

function harness(): {
  store: Tm1SqlitePublicationRecoveryStore
  databasePath: string
} {
  const directory = temporaryDirectory()
  const databasePath = join(directory, 'tm1.sqlite')
  return { store: openStore(databasePath), databasePath }
}

function cloneDatabase(sourcePath: string): string {
  const targetPath = join(temporaryDirectory(), 'tm1.sqlite')
  copyFileSync(sourcePath, targetPath)
  chmodSync(targetPath, 0o600)
  return targetPath
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'tm1-authority-gate-'))
  chmodSync(directory, 0o700)
  temporaryDirectories.push(directory)
  return directory
}

function openStore(databasePath: string): Tm1SqlitePublicationRecoveryStore {
  return createTm1SqlitePublicationRecoveryStore({ databasePath, now: () => 1_000 })
}
