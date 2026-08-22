import { describe, expect, test, vi } from 'vitest'
import {
  createTm1ChronikRecoveryObserver,
  parseTm1RecoveryObservation
} from './tm1ChronikRecoveryObserver'

const TXID = 'aa'.repeat(32)
const BLOCK_HASH = 'bb'.repeat(32)

describe('TM1 read-only Chronik recovery observer', () => {
  test.each(['absent', 'mempool'] as const)(
    'snapshots and freezes an exact %s observation',
    async status => {
      const result = { status, txid: TXID }
      const source = { observeTransaction: vi.fn().mockResolvedValue(result) }
      const observer = createTm1ChronikRecoveryObserver(source)

      const observation = await observer.observe({ txid: TXID })
      result.txid = 'cc'.repeat(32)

      expect(observation).toEqual({ status, txid: TXID })
      expect(Object.isFrozen(observation)).toBe(true)
      expect(source.observeTransaction).toHaveBeenCalledWith({ txid: TXID })
      expect(Object.isFrozen(source.observeTransaction.mock.calls[0]![0])).toBe(true)
    }
  )

  test('accepts only a positive exact confirmation', async () => {
    const observer = createTm1ChronikRecoveryObserver({
      observeTransaction: vi.fn().mockResolvedValue({
        status: 'confirmed',
        txid: TXID,
        confirmations: 3,
        blockHash: BLOCK_HASH,
        blockHeight: 109
      })
    })

    await expect(observer.observe({ txid: TXID })).resolves.toEqual({
      status: 'confirmed',
      txid: TXID,
      confirmations: 3,
      blockHash: BLOCK_HASH,
      blockHeight: 109
    })
  })

  test.each([
    { status: 'mempool', txid: 'cc'.repeat(32) },
    { status: 'confirmed', txid: TXID, confirmations: 0, blockHash: BLOCK_HASH, blockHeight: 1 },
    { status: 'confirmed', txid: TXID, confirmations: 1, blockHash: 'bad', blockHeight: 1 },
    { status: 'absent', txid: TXID, extra: true },
    null
  ])('rejects malformed or ambiguous observation %#', value => {
    expect(() => parseTm1RecoveryObservation(value, TXID)).toThrowError(
      expect.objectContaining({ code: 'INVALID_RECOVERY_OBSERVATION' })
    )
  })

  test('does not invoke hostile observation getters', () => {
    let getterCalls = 0
    const hostile: Record<string, unknown> = { txid: TXID }
    Object.defineProperty(hostile, 'status', {
      enumerable: true,
      get: () => {
        getterCalls += 1
        throw new Error('hostile getter')
      }
    })

    expect(() => parseTm1RecoveryObservation(hostile, TXID)).toThrowError(
      expect.objectContaining({ code: 'INVALID_RECOVERY_OBSERVATION' })
    )
    expect(getterCalls).toBe(0)
  })

  test('maps source failure to observation unavailable', async () => {
    const observer = createTm1ChronikRecoveryObserver({
      observeTransaction: vi.fn().mockRejectedValue(new Error('offline'))
    })

    await expect(observer.observe({ txid: TXID })).rejects.toMatchObject({
      code: 'OBSERVATION_UNAVAILABLE'
    })
  })

  test('stops waiting for a non-cooperative source when externally aborted', async () => {
    const source = { observeTransaction: vi.fn(() => new Promise(() => undefined)) }
    const observer = createTm1ChronikRecoveryObserver(source)
    const controller = new AbortController()
    const pending = observer.observe({ txid: TXID, signal: controller.signal })

    controller.abort()

    await expect(pending).rejects.toMatchObject({ code: 'OPERATION_ABORTED' })
  })

  test('observes a late source rejection after cancellation wins', async () => {
    let rejectSource: (reason: unknown) => void = () => undefined
    const late = new Promise<unknown>((_resolve, reject) => { rejectSource = reject })
    const observer = createTm1ChronikRecoveryObserver({
      observeTransaction: vi.fn().mockReturnValue(late)
    })
    const controller = new AbortController()
    const pending = observer.observe({ txid: TXID, signal: controller.signal })

    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'OPERATION_ABORTED' })
    expect(() => rejectSource(new Error('late rejection'))).not.toThrow()
    await Promise.resolve()
  })

  test('does not call the source when already aborted', async () => {
    const source = { observeTransaction: vi.fn() }
    const observer = createTm1ChronikRecoveryObserver(source)
    const controller = new AbortController()
    controller.abort()

    await expect(
      observer.observe({ txid: TXID, signal: controller.signal })
    ).rejects.toMatchObject({ code: 'OPERATION_ABORTED' })
    expect(source.observeTransaction).not.toHaveBeenCalled()
  })
})
