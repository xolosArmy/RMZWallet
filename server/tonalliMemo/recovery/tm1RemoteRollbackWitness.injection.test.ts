import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createTm1InMemoryRollbackWitness } from '../../../src/integrations/tonalliMemo/recovery/tm1InMemoryRollbackWitness'
import {
  Tm1RollbackWitnessError,
  parseTm1RollbackWitnessSnapshot
} from '../../../src/integrations/tonalliMemo/recovery/tm1RollbackWitness'
import {
  TM1_REMOTE_ROLLBACK_WITNESS_HTTP_PROTOCOL,
  TM1_REMOTE_ROLLBACK_WITNESS_HTTP_PROTOCOL_VERSION,
  createTm1RemoteRollbackWitness,
  type Tm1RemoteRollbackWitnessHttpOperation
} from '../../../src/integrations/tonalliMemo/recovery/tm1RemoteRollbackWitness'
import {
  establishTm1RollbackWitnessFreshness,
  provisionTm1RollbackWitness
} from './tm1RollbackWitnessAuthorityGate'
import { reserveTm1RollbackWitnessWithGrant } from './tm1RollbackWitnessReservationGrant'
import {
  createTm1SqlitePublicationRecoveryStore,
  type Tm1SqlitePublicationRecoveryStore
} from './tm1SqlitePublicationRecoveryStore'

const SLOT = 'account:device:tm1'
const STORE = `tm1-store:v1:${'a'.repeat(64)}`
const ENDPOINT = 'http://127.0.0.1:8787'
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('TM1 remote rollback-witness injected into Gate A', () => {
  test('abort through the adapter keeps AUTHORITY_GATE_ABORTED mapping', async () => {
    const { store } = harness()
    const { fetch } = protocolBackend()
    const witness = createTm1RemoteRollbackWitness({ endpointUrl: ENDPOINT, fetch })
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
    expect(store.inspectWitnessBinding()).toBeNull()
    store.close()
  })

  test('well-formed non-snapshot JSON is WITNESS_UNVERIFIABLE at the gate', async () => {
    const { store } = harness()
    const witness = createTm1RemoteRollbackWitness({
      endpointUrl: ENDPOINT,
      fetch: async () => jsonResponse({
        protocol: TM1_REMOTE_ROLLBACK_WITNESS_HTTP_PROTOCOL,
        protocolVersion: TM1_REMOTE_ROLLBACK_WITNESS_HTTP_PROTOCOL_VERSION,
        ok: true,
        result: { not: 'a-snapshot' }
      })
    })
    await expect(establishTm1RollbackWitnessFreshness(
      { store, witness },
      { slotId: SLOT }
    )).rejects.toMatchObject({ code: 'WITNESS_UNVERIFIABLE' })
    store.close()
  })

  test('verifyRecord false is WITNESS_UNVERIFIABLE at the gate', async () => {
    const { store } = harness()
    const { fetch } = protocolBackend()
    const honest = createTm1RemoteRollbackWitness({ endpointUrl: ENDPOINT, fetch })
    await provisionTm1RollbackWitness(
      { store, witness: honest },
      { slotId: SLOT, storeId: STORE, operationId: 'operation:enroll' }
    )
    const denying = createTm1RemoteRollbackWitness({
      endpointUrl: ENDPOINT,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith('/verifyRecord')) {
          return jsonResponse(success(false))
        }
        return fetch(input, init)
      }
    })
    await expect(establishTm1RollbackWitnessFreshness(
      { store, witness: denying },
      { slotId: SLOT }
    )).rejects.toMatchObject({ code: 'WITNESS_UNVERIFIABLE' })
    store.close()
  })

  test('reserve CAS miss does not issue a reservation grant', async () => {
    const { store } = harness()
    const { fetch, inner } = protocolBackend()
    const witness = createTm1RemoteRollbackWitness({ endpointUrl: ENDPOINT, fetch })
    await provisionTm1RollbackWitness(
      { store, witness },
      { slotId: SLOT, storeId: STORE, operationId: 'operation:enroll' }
    )
    const current = parseTm1RollbackWitnessSnapshot(await witness.read({ slotId: SLOT }))
    await expect(reserveTm1RollbackWitnessWithGrant(witness, {
      slotId: SLOT,
      storeId: STORE,
      expectedStableGeneration: 0,
      expectedStableLogicalRoot: current.stable.logicalRoot,
      expectedStableReceiptHash: 'd'.repeat(64),
      nextGeneration: 1,
      nextLogicalRoot: store.computeWitnessLogicalRoot(1),
      operationId: 'operation:advance'
    })).rejects.toMatchObject({ code: 'WITNESS_CONFLICT' })
    expect(inner.inspect(SLOT)?.pending).toBeNull()
    expect(store.inspectWitnessBinding()?.generation).toBe(0)
    store.close()
  })

  test('CASE A quarantines pending plus old DB', async () => {
    const { store } = harness()
    const { fetch, inner } = protocolBackend()
    const witness = createTm1RemoteRollbackWitness({ endpointUrl: ENDPOINT, fetch })
    await provisionTm1RollbackWitness(
      { store, witness },
      { slotId: SLOT, storeId: STORE, operationId: 'operation:enroll' }
    )
    const current = parseTm1RollbackWitnessSnapshot(await witness.read({ slotId: SLOT }))
    const reserved = await reserveTm1RollbackWitnessWithGrant(witness, {
      slotId: SLOT,
      storeId: STORE,
      expectedStableGeneration: 0,
      expectedStableLogicalRoot: current.stable.logicalRoot,
      expectedStableReceiptHash: current.stable.receiptHash,
      nextGeneration: 1,
      nextLogicalRoot: store.computeWitnessLogicalRoot(1),
      operationId: 'operation:advance'
    })
    await expect(establishTm1RollbackWitnessFreshness(
      { store, witness },
      { slotId: SLOT }
    )).rejects.toMatchObject({ code: 'WITNESS_PENDING_QUARANTINE' })
    expect(inner.inspect(SLOT)?.pending).toEqual(reserved.observation.pending)
    expect(store.inspectWitnessBinding()?.generation).toBe(0)
    store.close()
  })

  test('CASE B finalizes matching committed DB plus pending', async () => {
    const { store } = harness()
    const { fetch, inner } = protocolBackend()
    const witness = createTm1RemoteRollbackWitness({ endpointUrl: ENDPOINT, fetch })
    await provisionTm1RollbackWitness(
      { store, witness },
      { slotId: SLOT, storeId: STORE, operationId: 'operation:enroll' }
    )
    const current = parseTm1RollbackWitnessSnapshot(await witness.read({ slotId: SLOT }))
    const reserved = await reserveTm1RollbackWitnessWithGrant(witness, {
      slotId: SLOT,
      storeId: STORE,
      expectedStableGeneration: 0,
      expectedStableLogicalRoot: current.stable.logicalRoot,
      expectedStableReceiptHash: current.stable.receiptHash,
      nextGeneration: 1,
      nextLogicalRoot: store.computeWitnessLogicalRoot(1),
      operationId: 'operation:advance'
    })
    store.commitReservedWitnessBinding({
      expectedGeneration: 0,
      expectedLogicalRoot: current.stable.logicalRoot,
      pendingRecord: reserved.observation.pending,
      grant: reserved.grant
    })
    await expect(establishTm1RollbackWitnessFreshness(
      { store, witness },
      { slotId: SLOT }
    )).resolves.toMatchObject({ generation: 1 })
    expect(inner.inspect(SLOT)?.pending).toBeNull()
    expect(inner.inspect(SLOT)?.stable.generation).toBe(1)
    store.close()
  })
})

function protocolBackend(): {
  inner: ReturnType<typeof createTm1InMemoryRollbackWitness>
  fetch: typeof fetch
} {
  const inner = createTm1InMemoryRollbackWitness()
  const fetchImpl: typeof fetch = async (input, init) => {
    const operation = new URL(String(input)).pathname.split('/').at(-1) as
      Tm1RemoteRollbackWitnessHttpOperation
    const envelope = JSON.parse(String(init?.body)) as {
      payload: Record<string, unknown>
    }
    try {
      const result = await dispatch(inner, operation, envelope.payload)
      return jsonResponse(success(result))
    } catch (error) {
      if (error instanceof Tm1RollbackWitnessError) {
        return jsonResponse(failure(error.code), 409)
      }
      throw error
    }
  }
  return { inner, fetch: fetchImpl }
}

async function dispatch(
  inner: ReturnType<typeof createTm1InMemoryRollbackWitness>,
  operation: Tm1RemoteRollbackWitnessHttpOperation,
  payload: Record<string, unknown>
): Promise<unknown> {
  if (operation === 'read') return inner.read({ slotId: String(payload.slotId) })
  if (operation === 'enroll') {
    return inner.enroll({
      slotId: String(payload.slotId),
      storeId: String(payload.storeId),
      logicalRoot: String(payload.logicalRoot),
      operationId: String(payload.operationId)
    })
  }
  if (operation === 'reserve') {
    return inner.reserve({
      slotId: String(payload.slotId),
      storeId: String(payload.storeId),
      expectedStableGeneration: Number(payload.expectedStableGeneration),
      expectedStableLogicalRoot: String(payload.expectedStableLogicalRoot),
      expectedStableReceiptHash: String(payload.expectedStableReceiptHash),
      nextGeneration: Number(payload.nextGeneration),
      nextLogicalRoot: String(payload.nextLogicalRoot),
      operationId: String(payload.operationId)
    })
  }
  if (operation === 'finalize') {
    return inner.finalize({
      slotId: String(payload.slotId),
      storeId: String(payload.storeId),
      generation: Number(payload.generation),
      logicalRoot: String(payload.logicalRoot),
      operationId: String(payload.operationId),
      pendingReceiptHash: String(payload.pendingReceiptHash)
    })
  }
  return inner.verifyRecord(payload as never)
}

function success(result: unknown) {
  return {
    protocol: TM1_REMOTE_ROLLBACK_WITNESS_HTTP_PROTOCOL,
    protocolVersion: TM1_REMOTE_ROLLBACK_WITNESS_HTTP_PROTOCOL_VERSION,
    ok: true as const,
    result
  }
}

function failure(error: string) {
  return {
    protocol: TM1_REMOTE_ROLLBACK_WITNESS_HTTP_PROTOCOL,
    protocolVersion: TM1_REMOTE_ROLLBACK_WITNESS_HTTP_PROTOCOL_VERSION,
    ok: false as const,
    error
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function harness(): { store: Tm1SqlitePublicationRecoveryStore } {
  const directory = mkdtempSync(join(tmpdir(), 'tm1-remote-witness-'))
  chmodSync(directory, 0o700)
  temporaryDirectories.push(directory)
  return {
    store: createTm1SqlitePublicationRecoveryStore({
      databasePath: join(directory, 'tm1.sqlite'),
      now: () => 1_000
    })
  }
}
