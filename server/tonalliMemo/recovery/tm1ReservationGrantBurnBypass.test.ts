import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { Tm1PublicationRecoveryStoreError } from '../../../src/integrations/tonalliMemo/recovery/tm1PublicationRecoveryStore'
import { createTm1InMemoryRollbackWitness } from '../../../src/integrations/tonalliMemo/recovery/tm1InMemoryRollbackWitness'
import {
  parseTm1RollbackWitnessSnapshot,
  type Tm1RollbackWitness
} from '../../../src/integrations/tonalliMemo/recovery/tm1RollbackWitness'
import {
  establishTm1RollbackWitnessFreshness,
  provisionTm1RollbackWitness
} from './tm1RollbackWitnessAuthorityGate'
import {
  reserveTm1RollbackWitnessWithGrant,
  withTm1RollbackWitnessReservationGrant,
  type Tm1RollbackWitnessReservationOutcome
} from './tm1RollbackWitnessReservationGrant'
import {
  createTm1SqlitePublicationRecoveryStore,
  type Tm1SqlitePublicationRecoveryStore
} from './tm1SqlitePublicationRecoveryStore'

const SLOT = 'account:device:tm1'
const STORE = `tm1-store:v1:${'a'.repeat(64)}`
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('TM1 P1-2 ReservationGrant burn-before-operate', () => {
  test('operate throw burns the exact grant and rejects a second attempt', async () => {
    const { store } = harness()
    const witness = createTm1InMemoryRollbackWitness()
    await provision(store, witness)
    const outcome = await reserveGrant(store, witness, 'operation:p1-2-operate-throw')
    const entries: string[] = []

    expect(() => withTm1RollbackWitnessReservationGrant(
      outcome.grant,
      () => undefined,
      () => {
        entries.push('first')
        throw new Error('injected operate failure')
      }
    )).toThrowError('injected operate failure')
    expect(entries).toEqual(['first'])

    expect(() => withTm1RollbackWitnessReservationGrant(
      outcome.grant,
      () => {
        entries.push('second-prepare')
      },
      () => {
        entries.push('second-operate')
        return 'must-not-run'
      }
    )).toThrowError(expect.objectContaining({
      code: 'WITNESS_RESERVATION_FENCE_MISMATCH'
    }))
    expect(() => store.commitReservedWitnessBinding(exactCommitInput(outcome)))
      .toThrowError(expect.objectContaining({
        code: 'WITNESS_RESERVATION_FENCE_MISMATCH'
      }))
    expect(entries).toEqual(['first'])
    expect(store.inspectWitnessBinding()?.generation).toBe(0)
    store.close()
  })

  test('nested same-grant invocation rejects before nested operate executes', async () => {
    const { store } = harness()
    const witness = createTm1InMemoryRollbackWitness()
    await provision(store, witness)
    const outcome = await reserveGrant(store, witness, 'operation:p1-2-reenter')
    const entries: string[] = []

    const result = withTm1RollbackWitnessReservationGrant(
      outcome.grant,
      () => undefined,
      evidence => {
        entries.push('outer')
        expect(() => withTm1RollbackWitnessReservationGrant(
          outcome.grant,
          () => {
            entries.push('nested-prepare')
          },
          () => {
            entries.push('nested-operate')
            return 'nested-authority'
          }
        )).toThrowError(expect.objectContaining({
          code: 'WITNESS_RESERVATION_FENCE_MISMATCH'
        }))
        return evidence.nextGeneration
      }
    )
    expect(result).toBe(1)
    expect(entries).toEqual(['outer'])
    expect(() => withTm1RollbackWitnessReservationGrant(
      outcome.grant,
      () => {
        entries.push('later-prepare')
      },
      () => {
        entries.push('later-operate')
        return 'later'
      }
    )).toThrowError(expect.objectContaining({
      code: 'WITNESS_RESERVATION_FENCE_MISMATCH'
    }))
    expect(entries).toEqual(['outer'])
    store.close()
  })

  test('asynchronous reuse of the same exact grant is rejected after operate starts', async () => {
    const { store } = harness()
    const witness = createTm1InMemoryRollbackWitness()
    await provision(store, witness)
    const outcome = await reserveGrant(store, witness, 'operation:p1-2-async-reuse')
    const entries: string[] = []

    const pending = new Promise<void>((resolve, reject) => {
      queueMicrotask(() => {
        try {
          expect(() => withTm1RollbackWitnessReservationGrant(
            outcome.grant,
            () => {
              entries.push('microtask-prepare')
            },
            () => {
              entries.push('microtask-operate')
              return 'microtask'
            }
          )).toThrowError(expect.objectContaining({
            code: 'WITNESS_RESERVATION_FENCE_MISMATCH'
          }))
          resolve()
        } catch (error) {
          reject(error)
        }
      })
    })
    withTm1RollbackWitnessReservationGrant(
      outcome.grant,
      () => undefined,
      () => {
        entries.push('operate')
        return 'done'
      }
    )
    await pending
    expect(entries).toEqual(['operate'])
    store.close()
  })

  test('pure validation failure before burn leaves operate unentered', async () => {
    const { store } = harness()
    const witness = createTm1InMemoryRollbackWitness()
    await provision(store, witness)
    const outcome = await reserveGrant(store, witness, 'operation:p1-2-prepare-retry')
    const entries: string[] = []

    expect(() => withTm1RollbackWitnessReservationGrant(
      outcome.grant,
      () => {
        entries.push('prepare')
        throw new Tm1PublicationRecoveryStoreError('WITNESS_RESERVATION_FENCE_MISMATCH')
      },
      () => {
        entries.push('operate')
        return 'must-not-run'
      }
    )).toThrowError(expect.objectContaining({
      code: 'WITNESS_RESERVATION_FENCE_MISMATCH'
    }))
    expect(entries).toEqual(['prepare'])
    expect(store.commitReservedWitnessBinding(exactCommitInput(outcome)))
      .toMatchObject({ generation: 1 })
    store.close()
  })

  test('failed BEGIN does not restore grant authority', async () => {
    const { store } = harness()
    const witness = createTm1InMemoryRollbackWitness()
    await provision(store, witness)
    const outcome = await reserveGrant(store, witness, 'operation:p1-2-begin-fail')
    const before = store.inspectWitnessBinding()
    withExec(store, (sql, original) => {
      if (sql === 'BEGIN IMMEDIATE') throw new Error('injected begin failure')
      return original(sql)
    }, () => {
      expect(() => store.commitReservedWitnessBinding(exactCommitInput(outcome)))
        .toThrowError(expect.objectContaining({
          code: 'RECOVERY_STORE_FAILED'
        }))
    })
    expect(store.inspectWitnessBinding()).toEqual(before)
    expect(() => store.commitReservedWitnessBinding(exactCommitInput(outcome)))
      .toThrowError(expect.objectContaining({
        code: 'WITNESS_RESERVATION_FENCE_MISMATCH'
      }))
    await expect(establishTm1RollbackWitnessFreshness(
      { store, witness },
      { slotId: SLOT }
    )).rejects.toMatchObject({ code: 'WITNESS_PENDING_QUARANTINE' })
    store.close()
  })

  test('mutation failure does not restore grant authority', async () => {
    const { store } = harness()
    const witness = createTm1InMemoryRollbackWitness()
    await provision(store, witness)
    const outcome = await reserveGrant(store, witness, 'operation:p1-2-mutation-fail')
    const before = store.inspectWitnessBinding()
    withPrepare(store, (sql, original) => {
      if (sql.includes('UPDATE tm1_witness_binding')) {
        throw new Error('injected mutation failure')
      }
      return original(sql)
    }, () => {
      expect(() => store.commitReservedWitnessBinding(exactCommitInput(outcome)))
        .toThrowError(expect.objectContaining({
          code: 'RECOVERY_STORE_FAILED'
        }))
    })
    expect(store.inspectWitnessBinding()).toEqual(before)
    expect(() => store.commitReservedWitnessBinding(exactCommitInput(outcome)))
      .toThrowError(expect.objectContaining({
        code: 'WITNESS_RESERVATION_FENCE_MISMATCH'
      }))
    store.close()
  })

  test('simulated COMMIT failure burns the grant and quarantines old DB plus pending', async () => {
    const { store } = harness()
    const witness = createTm1InMemoryRollbackWitness()
    await provision(store, witness)
    const outcome = await reserveGrant(store, witness, 'operation:p1-2-commit-fail')
    const before = store.inspectWitnessBinding()
    withExec(store, (sql, original) => {
      if (sql === 'COMMIT') throw new Error('injected commit failure')
      return original(sql)
    }, () => {
      expect(() => store.commitReservedWitnessBinding(exactCommitInput(outcome)))
        .toThrowError(expect.objectContaining({
          code: 'RECOVERY_STORE_FAILED'
        }))
    })
    expect(store.inspectWitnessBinding()).toEqual(before)
    expect(() => store.commitReservedWitnessBinding(exactCommitInput(outcome)))
      .toThrowError(expect.objectContaining({
        code: 'WITNESS_RESERVATION_FENCE_MISMATCH'
      }))
    await expect(establishTm1RollbackWitnessFreshness(
      { store, witness },
      { slotId: SLOT }
    )).rejects.toMatchObject({ code: 'WITNESS_PENDING_QUARANTINE' })
    expect(witness.inspect(SLOT)?.pending).toEqual(outcome.observation.pending)
    expect(store.inspectWitnessBinding()?.generation).toBe(0)
    store.close()
  })

  test('matching committed DB plus pending remains finalize-only and rejects the same grant', async () => {
    const { store } = harness()
    const witness = createTm1InMemoryRollbackWitness()
    await provision(store, witness)
    const outcome = await reserveGrant(store, witness, 'operation:p1-2-finalize-only')
    expect(store.commitReservedWitnessBinding(exactCommitInput(outcome)))
      .toMatchObject({ generation: 1, logicalRoot: outcome.grant.nextLogicalRoot })
    expect(() => store.commitReservedWitnessBinding(exactCommitInput(outcome)))
      .toThrowError(expect.objectContaining({
        code: 'WITNESS_RESERVATION_FENCE_MISMATCH'
      }))
    await expect(establishTm1RollbackWitnessFreshness(
      { store, witness },
      { slotId: SLOT }
    )).resolves.toMatchObject({
      generation: 1,
      logicalRoot: outcome.grant.nextLogicalRoot
    })
    expect(witness.inspect(SLOT)?.pending).toBeNull()
    expect(witness.inspect(SLOT)?.stable.generation).toBe(1)
    store.close()
  })

  test('copied reconstructed and proxy grants still reject before burn', async () => {
    const { store } = harness()
    const witness = createTm1InMemoryRollbackWitness()
    await provision(store, witness)
    const outcome = await reserveGrant(store, witness, 'operation:p1-2-lookalike')
    const before = store.inspectWitnessBinding()
    const pending = outcome.observation.pending
    for (const grant of [
      { ...outcome.grant },
      Object.freeze({ ...outcome.grant }),
      Object.assign(Object.create(null), outcome.grant),
      pending,
      { ...pending }
    ]) {
      expect(() => (store.commitReservedWitnessBinding as (value: unknown) => unknown)({
        ...exactCommitInput(outcome),
        grant
      })).toThrowError(expect.objectContaining({
        code: 'WITNESS_RESERVATION_GRANT_REQUIRED'
      }))
      expect(store.inspectWitnessBinding()).toEqual(before)
    }
    expect(store.commitReservedWitnessBinding(exactCommitInput(outcome)))
      .toMatchObject({ generation: 1 })
    store.close()
  })

  test('two-controller loser cannot commit with winner-pending evidence', async () => {
    const first = harness()
    const witness = createTm1InMemoryRollbackWitness()
    await provision(first.store, witness)
    const second = openStore(first.databasePath)
    const stable = parseTm1RollbackWitnessSnapshot(
      await witness.read({ slotId: SLOT })
    ).stable
    const nextRoot = first.store.computeWitnessLogicalRoot(1)
    const baseRequest = {
      slotId: SLOT,
      storeId: STORE,
      expectedStableGeneration: stable.generation,
      expectedStableLogicalRoot: stable.logicalRoot,
      expectedStableReceiptHash: stable.receiptHash,
      nextGeneration: 1,
      nextLogicalRoot: nextRoot
    }
    const results = await Promise.allSettled([
      reserveTm1RollbackWitnessWithGrant(witness, {
        ...baseRequest,
        operationId: 'operation:controller:a'
      }),
      reserveTm1RollbackWitnessWithGrant(witness, {
        ...baseRequest,
        operationId: 'operation:controller:b'
      })
    ])
    const winners = results.filter(
      (result): result is PromiseFulfilledResult<Tm1RollbackWitnessReservationOutcome> =>
        result.status === 'fulfilled'
    )
    expect(winners).toHaveLength(1)
    const winner = winners[0].value
    const observed = parseTm1RollbackWitnessSnapshot(
      await witness.read({ slotId: SLOT })
    )
    expect(() => (second.commitReservedWitnessBinding as (value: unknown) => unknown)({
      expectedGeneration: 0,
      expectedLogicalRoot: stable.logicalRoot,
      pendingRecord: observed.pending,
      grant: { ...winner.grant }
    })).toThrowError(expect.objectContaining({
      code: 'WITNESS_RESERVATION_GRANT_REQUIRED'
    }))
    expect(first.store.commitReservedWitnessBinding(exactCommitInput(winner)))
      .toMatchObject({ generation: 1 })
    expect(() => second.commitReservedWitnessBinding(exactCommitInput(winner)))
      .toThrowError(expect.objectContaining({
        code: 'WITNESS_RESERVATION_FENCE_MISMATCH'
      }))
    first.store.close()
    second.close()
  })

  test('prepare reentry of the exact grant is rejected and burns after outer prepare succeeds', async () => {
    const { store } = harness()
    const witness = createTm1InMemoryRollbackWitness()
    await provision(store, witness)
    const outcome = await reserveGrant(store, witness, 'operation:p1-3-prepare-reentry')
    const entries: string[] = []

    const result = withTm1RollbackWitnessReservationGrant(
      outcome.grant,
      () => {
        entries.push('outer-prepare')
        expect(() => withTm1RollbackWitnessReservationGrant(
          outcome.grant,
          () => {
            entries.push('nested-prepare')
          },
          () => {
            entries.push('nested-operate')
            return 'nested-authority'
          }
        )).toThrowError(expect.objectContaining({
          code: 'WITNESS_RESERVATION_FENCE_MISMATCH'
        }))
      },
      evidence => {
        entries.push('outer-operate')
        return evidence.nextGeneration
      }
    )
    expect(result).toBe(1)
    expect(entries).toEqual(['outer-prepare', 'outer-operate'])
    expect(() => withTm1RollbackWitnessReservationGrant(
      outcome.grant,
      () => {
        entries.push('later-prepare')
      },
      () => {
        entries.push('later-operate')
        return 'later'
      }
    )).toThrowError(expect.objectContaining({
      code: 'WITNESS_RESERVATION_FENCE_MISMATCH'
    }))
    expect(() => store.commitReservedWitnessBinding(exactCommitInput(outcome)))
      .toThrowError(expect.objectContaining({
        code: 'WITNESS_RESERVATION_FENCE_MISMATCH'
      }))
    expect(entries).toEqual(['outer-prepare', 'outer-operate'])
    store.close()
  })

  test('prepare fence mismatch before nested operate leaves the exact grant retryable', async () => {
    const { store } = harness()
    const witness = createTm1InMemoryRollbackWitness()
    await provision(store, witness)
    const outcome = await reserveGrant(store, witness, 'operation:p1-3-prepare-fence-retry')
    const entries: string[] = []

    expect(() => withTm1RollbackWitnessReservationGrant(
      outcome.grant,
      () => {
        entries.push('prepare')
        throw new Tm1PublicationRecoveryStoreError('WITNESS_RESERVATION_FENCE_MISMATCH')
      },
      () => {
        entries.push('operate')
        return 'must-not-run'
      }
    )).toThrowError(expect.objectContaining({
      code: 'WITNESS_RESERVATION_FENCE_MISMATCH'
    }))
    expect(entries).toEqual(['prepare'])
    expect(store.commitReservedWitnessBinding(exactCommitInput(outcome)))
      .toMatchObject({ generation: 1 })
    store.close()
  })

  test('prepare generic error burns the exact grant before operate', async () => {
    const { store } = harness()
    const witness = createTm1InMemoryRollbackWitness()
    await provision(store, witness)
    const outcome = await reserveGrant(store, witness, 'operation:p1-3-prepare-generic-burn')
    const entries: string[] = []

    expect(() => withTm1RollbackWitnessReservationGrant(
      outcome.grant,
      () => {
        entries.push('prepare')
        throw new Error('injected prepare failure')
      },
      () => {
        entries.push('operate')
        return 'must-not-run'
      }
    )).toThrowError('injected prepare failure')
    expect(entries).toEqual(['prepare'])
    expect(() => withTm1RollbackWitnessReservationGrant(
      outcome.grant,
      () => {
        entries.push('later-prepare')
      },
      () => {
        entries.push('later-operate')
        return 'later'
      }
    )).toThrowError(expect.objectContaining({
      code: 'WITNESS_RESERVATION_FENCE_MISMATCH'
    }))
    expect(() => store.commitReservedWitnessBinding(exactCommitInput(outcome)))
      .toThrowError(expect.objectContaining({
        code: 'WITNESS_RESERVATION_FENCE_MISMATCH'
      }))
    expect(entries).toEqual(['prepare'])
    expect(store.inspectWitnessBinding()?.generation).toBe(0)
    store.close()
  })

  test('wrong caller expected generation is rejected before burn', async () => {
    const { store } = harness()
    const witness = createTm1InMemoryRollbackWitness()
    await provision(store, witness)
    const outcome = await reserveGrant(store, witness, 'operation:p1-2-wrong-expected')
    const before = store.inspectWitnessBinding()
    expect(() => store.commitReservedWitnessBinding({
      ...exactCommitInput(outcome),
      expectedGeneration: 1
    })).toThrowError(expect.objectContaining({
      code: 'WITNESS_RESERVATION_FENCE_MISMATCH'
    }))
    expect(store.inspectWitnessBinding()).toEqual(before)
    expect(store.commitReservedWitnessBinding(exactCommitInput(outcome)))
      .toMatchObject({ generation: 1 })
    store.close()
  })
})

function harness(): {
  store: Tm1SqlitePublicationRecoveryStore
  databasePath: string
} {
  const directory = mkdtempSync(join(tmpdir(), 'tm1-grant-burn-bypass-'))
  chmodSync(directory, 0o700)
  temporaryDirectories.push(directory)
  const databasePath = join(directory, 'tm1.sqlite')
  return { store: openStore(databasePath), databasePath }
}

function openStore(databasePath: string): Tm1SqlitePublicationRecoveryStore {
  return createTm1SqlitePublicationRecoveryStore({ databasePath, now: () => 1_000 })
}

async function provision(
  store: Tm1SqlitePublicationRecoveryStore,
  witness: Tm1RollbackWitness
): Promise<void> {
  await provisionTm1RollbackWitness(
    { store, witness },
    { slotId: SLOT, storeId: STORE, operationId: 'operation:enroll' }
  )
}

async function reserveGrant(
  store: Tm1SqlitePublicationRecoveryStore,
  witness: Tm1RollbackWitness,
  operationId: string
): Promise<Tm1RollbackWitnessReservationOutcome> {
  const stable = parseTm1RollbackWitnessSnapshot(
    await witness.read({ slotId: SLOT })
  ).stable
  return reserveTm1RollbackWitnessWithGrant(witness, {
    slotId: SLOT,
    storeId: STORE,
    expectedStableGeneration: stable.generation,
    expectedStableLogicalRoot: stable.logicalRoot,
    expectedStableReceiptHash: stable.receiptHash,
    nextGeneration: stable.generation + 1,
    nextLogicalRoot: store.computeWitnessLogicalRoot(stable.generation + 1),
    operationId
  })
}

function exactCommitInput(outcome: Tm1RollbackWitnessReservationOutcome) {
  return {
    expectedGeneration: outcome.grant.previousStableGeneration,
    expectedLogicalRoot: outcome.grant.previousStableLogicalRoot,
    pendingRecord: outcome.observation.pending,
    grant: outcome.grant
  }
}

function storeDatabase(store: Tm1SqlitePublicationRecoveryStore): {
  exec: (sql: string) => unknown
  prepare: (sql: string) => unknown
} {
  return Reflect.get(store, 'database') as {
    exec: (sql: string) => unknown
    prepare: (sql: string) => unknown
  }
}

function withExec(
  store: Tm1SqlitePublicationRecoveryStore,
  intercept: (sql: string, original: (sql: string) => unknown) => unknown,
  body: () => void
): void {
  const database = storeDatabase(store)
  const original = database.exec.bind(database)
  database.exec = (sql: string) => intercept(sql, original)
  try {
    body()
  } finally {
    database.exec = original
  }
}

function withPrepare(
  store: Tm1SqlitePublicationRecoveryStore,
  intercept: (sql: string, original: (sql: string) => unknown) => unknown,
  body: () => void
): void {
  const database = storeDatabase(store)
  const original = database.prepare.bind(database)
  database.prepare = (sql: string) => intercept(sql, original)
  try {
    body()
  } finally {
    database.prepare = original
  }
}
