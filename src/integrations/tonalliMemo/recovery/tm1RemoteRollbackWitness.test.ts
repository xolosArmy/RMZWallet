import { describe, expect, test } from 'vitest'
import { createTm1InMemoryRollbackWitness } from './tm1InMemoryRollbackWitness'
import {
  Tm1RollbackWitnessError,
  parseTm1RollbackWitnessSnapshot
} from './tm1RollbackWitness'
import {
  TM1_REMOTE_ROLLBACK_WITNESS_HTTP_PROTOCOL,
  TM1_REMOTE_ROLLBACK_WITNESS_HTTP_PROTOCOL_VERSION,
  createTm1RemoteRollbackWitness,
  createTm1RemoteRollbackWitnessFromEnv,
  type Tm1RemoteRollbackWitnessHttpOperation
} from './tm1RemoteRollbackWitness'

const SLOT = 'account:device:tm1'
const STORE = `tm1-store:v1:${'a'.repeat(64)}`
const ROOT_0 = 'b'.repeat(64)
const ROOT_1 = 'c'.repeat(64)
const ENDPOINT = 'https://witness.example/tm1'
const LOOPBACK = 'http://127.0.0.1:8787'

describe('TM1 remote rollback-witness adapter', () => {
  test('unconfigured or invalid config is WITNESS_NOT_CONFIGURED', () => {
    const invalid: unknown[] = [
      undefined,
      null,
      {},
      { endpointUrl: '' },
      { endpointUrl: '  https://witness.example' },
      { endpointUrl: 'https://user:pass@witness.example' },
      { endpointUrl: 'https://witness.example?x=1' },
      { endpointUrl: 'https://witness.example#frag' },
      { endpointUrl: 'http://witness.example' },
      { endpointUrl: 'ftp://127.0.0.1' },
      { endpointUrl: ENDPOINT, timeoutMs: 0 },
      { endpointUrl: ENDPOINT, timeoutMs: 61_000 },
      { endpointUrl: ENDPOINT, extra: true },
      { endpointUrl: ENDPOINT, fetch: 1 }
    ]
    for (const config of invalid) {
      expect(() => createTm1RemoteRollbackWitness(config))
        .toThrowError(expect.objectContaining({ code: 'WITNESS_NOT_CONFIGURED' }))
    }
    expect(() => createTm1RemoteRollbackWitnessFromEnv({}))
      .toThrowError(expect.objectContaining({ code: 'WITNESS_NOT_CONFIGURED' }))
  })

  test('does not substitute the in-memory witness when env is empty', () => {
    expect(() => createTm1RemoteRollbackWitnessFromEnv({
      TM1_ROLLBACK_WITNESS_ENDPOINT_URL: ''
    })).toThrowError(expect.objectContaining({ code: 'WITNESS_NOT_CONFIGURED' }))
  })

  test('abort signal maps to WITNESS_UNAVAILABLE', async () => {
    const abort = new AbortController()
    abort.abort()
    const witness = createTm1RemoteRollbackWitness({
      endpointUrl: ENDPOINT,
      fetch: async () => {
        throw new Error('must not fetch')
      }
    })
    await expect(witness.read({ slotId: SLOT, signal: abort.signal }))
      .rejects.toMatchObject({ code: 'WITNESS_UNAVAILABLE' })
  })

  test('HTTP error, timeout and truncated body are WITNESS_UNAVAILABLE', async () => {
    await expect(createTm1RemoteRollbackWitness({
      endpointUrl: ENDPOINT,
      fetch: async () => jsonResponse({ message: 'no' }, 500)
    }).read({ slotId: SLOT })).rejects.toMatchObject({ code: 'WITNESS_UNAVAILABLE' })

    await expect(createTm1RemoteRollbackWitness({
      endpointUrl: ENDPOINT,
      fetch: async () => {
        throw new TypeError('network down')
      }
    }).read({ slotId: SLOT })).rejects.toMatchObject({ code: 'WITNESS_UNAVAILABLE' })

    await expect(createTm1RemoteRollbackWitness({
      endpointUrl: ENDPOINT,
      fetch: async () => new Response('{"ok":tru', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }).read({ slotId: SLOT })).rejects.toMatchObject({ code: 'WITNESS_UNAVAILABLE' })

    await expect(createTm1RemoteRollbackWitness({
      endpointUrl: ENDPOINT,
      timeoutMs: 20,
      fetch: async (_url: RequestInfo | URL, init?: RequestInit) => {
        await new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'))
          })
        })
        return jsonResponse(success(null))
      }
    }).read({ slotId: SLOT })).rejects.toMatchObject({ code: 'WITNESS_UNAVAILABLE' })
  })

  test('reader.cancel() AbortError on hanging-body abort is not unhandled', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const timeoutMs = 40
      const witness = createTm1RemoteRollbackWitness({
        endpointUrl: ENDPOINT,
        timeoutMs,
        fetch: async () => hangingResponse()
      })
      await expect(witness.read({ slotId: SLOT }))
        .rejects.toMatchObject({ code: 'WITNESS_UNAVAILABLE' })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  }, 1_000)

  test('timeout still applies while decoding a hanging response body', async () => {
    const timeoutMs = 40
    const witness = createTm1RemoteRollbackWitness({
      endpointUrl: ENDPOINT,
      timeoutMs,
      fetch: async () => hangingResponse()
    })
    const started = Date.now()
    await expect(witness.read({ slotId: SLOT }))
      .rejects.toMatchObject({ code: 'WITNESS_UNAVAILABLE' })
    expect(Date.now() - started).toBeLessThan(timeoutMs + 250)
  }, 1_000)

  test('caller abort still aborts hanging body decode', async () => {
    const abort = new AbortController()
    const witness = createTm1RemoteRollbackWitness({
      endpointUrl: ENDPOINT,
      timeoutMs: 8_000,
      fetch: async () => hangingResponse()
    })
    const pending = witness.read({ slotId: SLOT, signal: abort.signal })
    await new Promise(resolve => setTimeout(resolve, 20))
    abort.abort()
    await expect(pending).rejects.toMatchObject({ code: 'WITNESS_UNAVAILABLE' })
  }, 1_000)

  test('oversized body is rejected before the whole payload is buffered', async () => {
    const maxBytes = 65_536
    const chunkSize = 4_096
    let pulled = 0
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      pull (controller) {
        if (pulled >= maxBytes * 3) {
          controller.close()
          return
        }
        pulled += chunkSize
        controller.enqueue(new Uint8Array(chunkSize).fill(0x61))
      },
      cancel () {
        cancelled = true
      }
    })
    const witness = createTm1RemoteRollbackWitness({
      endpointUrl: ENDPOINT,
      fetch: async () => new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })
    await expect(witness.read({ slotId: SLOT }))
      .rejects.toMatchObject({ code: 'WITNESS_UNAVAILABLE' })
    expect(cancelled).toBe(true)
    expect(pulled).toBeLessThan(maxBytes * 3)
    expect(pulled).toBeLessThanOrEqual(maxBytes + chunkSize * 2)
  })

  test('HTTP 200 empty body is WITNESS_UNAVAILABLE', async () => {
    const witness = createTm1RemoteRollbackWitness({
      endpointUrl: ENDPOINT,
      fetch: async () => new Response('', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })
    await expect(witness.read({ slotId: SLOT }))
      .rejects.toMatchObject({ code: 'WITNESS_UNAVAILABLE' })
  })

  test('bare JSON null on read is not never-enrolled', async () => {
    const witness = createTm1RemoteRollbackWitness({
      endpointUrl: ENDPOINT,
      fetch: async () => new Response('null', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })
    await expect(witness.read({ slotId: SLOT })).rejects.toMatchObject({
      code: expect.stringMatching(/^(WITNESS_UNAVAILABLE|WITNESS_UNVERIFIABLE)$/)
    })
  })

  test('success envelope result null on read is never-enrolled', async () => {
    const witness = createTm1RemoteRollbackWitness({
      endpointUrl: ENDPOINT,
      fetch: async () => jsonResponse(success(null))
    })
    await expect(witness.read({ slotId: SLOT })).resolves.toBeNull()
  })

  test('well-formed JSON that is not a snapshot is returned as unknown', async () => {
    const witness = createTm1RemoteRollbackWitness({
      endpointUrl: ENDPOINT,
      fetch: async () => jsonResponse({ hello: 'world' })
    })
    await expect(witness.read({ slotId: SLOT })).resolves.toEqual({ hello: 'world' })
    expect(() => parseTm1RollbackWitnessSnapshot({ hello: 'world' }))
      .toThrowError(Tm1RollbackWitnessError)
  })

  test('null read means never enrolled', async () => {
    const { fetch } = protocolBackend()
    const witness = createTm1RemoteRollbackWitness({
      endpointUrl: LOOPBACK,
      fetch
    })
    await expect(witness.read({ slotId: SLOT })).resolves.toBeNull()
  })

  test('enroll CAS conflict is WITNESS_ALREADY_ENROLLED', async () => {
    const { fetch } = protocolBackend()
    const witness = createTm1RemoteRollbackWitness({ endpointUrl: LOOPBACK, fetch })
    await witness.enroll({
      slotId: SLOT,
      storeId: STORE,
      logicalRoot: ROOT_0,
      operationId: 'operation:enroll'
    })
    await expect(witness.enroll({
      slotId: SLOT,
      storeId: STORE,
      logicalRoot: ROOT_0,
      operationId: 'operation:enroll-again'
    })).rejects.toMatchObject({ code: 'WITNESS_ALREADY_ENROLLED' })
  })

  test('reserve CAS miss is WITNESS_CONFLICT', async () => {
    const { fetch } = protocolBackend()
    const witness = createTm1RemoteRollbackWitness({ endpointUrl: LOOPBACK, fetch })
    await witness.enroll({
      slotId: SLOT,
      storeId: STORE,
      logicalRoot: ROOT_0,
      operationId: 'operation:enroll'
    })
    await expect(witness.reserve({
      slotId: SLOT,
      storeId: STORE,
      expectedStableGeneration: 0,
      expectedStableLogicalRoot: ROOT_0,
      expectedStableReceiptHash: 'd'.repeat(64),
      nextGeneration: 1,
      nextLogicalRoot: ROOT_1,
      operationId: 'operation:advance'
    })).rejects.toMatchObject({ code: 'WITNESS_CONFLICT' })
  })

  test('verifyRecord false when the remote does not authenticate the record', async () => {
    const { fetch } = protocolBackend()
    const witness = createTm1RemoteRollbackWitness({ endpointUrl: LOOPBACK, fetch })
    const enrolled = parseTm1RollbackWitnessSnapshot(await witness.enroll({
      slotId: SLOT,
      storeId: STORE,
      logicalRoot: ROOT_0,
      operationId: 'operation:enroll'
    }))
    expect(await witness.verifyRecord(enrolled.stable)).toBe(true)
    const foreign = parseTm1RollbackWitnessSnapshot(
      await createTm1InMemoryRollbackWitness().enroll({
        slotId: 'foreign:slot',
        storeId: STORE,
        logicalRoot: ROOT_0,
        operationId: 'operation:foreign'
      })
    )
    expect(await witness.verifyRecord(foreign.stable)).toBe(false)
  })

  test('round-trips enroll, reserve and finalize through the HTTP envelope', async () => {
    const { fetch } = protocolBackend()
    const witness = createTm1RemoteRollbackWitness({ endpointUrl: LOOPBACK, fetch })
    const enrolled = parseTm1RollbackWitnessSnapshot(await witness.enroll({
      slotId: SLOT,
      storeId: STORE,
      logicalRoot: ROOT_0,
      operationId: 'operation:enroll'
    }))
    const reserved = parseTm1RollbackWitnessSnapshot(await witness.reserve({
      slotId: SLOT,
      storeId: STORE,
      expectedStableGeneration: 0,
      expectedStableLogicalRoot: ROOT_0,
      expectedStableReceiptHash: enrolled.stable.receiptHash,
      nextGeneration: 1,
      nextLogicalRoot: ROOT_1,
      operationId: 'operation:advance'
    }))
    expect(reserved.pending).toMatchObject({ generation: 1, logicalRoot: ROOT_1 })
    const finalized = parseTm1RollbackWitnessSnapshot(await witness.finalize({
      slotId: SLOT,
      storeId: STORE,
      generation: 1,
      logicalRoot: ROOT_1,
      operationId: 'operation:advance',
      pendingReceiptHash: reserved.pending!.receiptHash
    }))
    expect(finalized.pending).toBeNull()
    expect(finalized.stable.generation).toBe(1)
  })
})

function protocolBackend(): {
  inner: ReturnType<typeof createTm1InMemoryRollbackWitness>
  fetch: typeof fetch
} {
  const inner = createTm1InMemoryRollbackWitness()
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    const operation = operationFromUrl(url)
    const envelope = JSON.parse(String(init?.body)) as {
      operation: Tm1RemoteRollbackWitnessHttpOperation
      payload: Record<string, unknown>
    }
    expect(envelope.operation).toBe(operation)
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

function operationFromUrl(url: string): Tm1RemoteRollbackWitnessHttpOperation {
  const value = new URL(url).pathname.split('/').at(-1)
  if (
    value === 'read' || value === 'enroll' || value === 'reserve' ||
    value === 'finalize' || value === 'verifyRecord'
  ) return value
  throw new Error(`unexpected operation path ${url}`)
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

function hangingResponse(): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start () {
      // Never enqueue or close: body decode must be aborted by timeout or caller.
    },
    cancel () {
      return Promise.reject(new DOMException('Aborted', 'AbortError'))
    }
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}
