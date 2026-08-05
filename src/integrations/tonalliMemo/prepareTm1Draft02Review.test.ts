import { describe, expect, it, vi } from 'vitest'
import {
  Tm1Draft02ReviewError,
  prepareTm1Draft02Review,
  type Tm1Draft02ReviewDependencies
} from './prepareTm1Draft02Review'

const ADDRESS = 'ecash:qptestaddress'
const ACTIVE_PKH = '11'.repeat(20)
const ACTIVE_SCRIPT = `76a914${ACTIVE_PKH}88ac`

const txid = (byte: string) => byte.repeat(64)

const dependencies = (
  overrides: Partial<Tm1Draft02ReviewDependencies> = {}
): Tm1Draft02ReviewDependencies => ({
  getActiveAddress: () => ADDRESS,
  addressToLockingScriptHex: () => ACTIVE_SCRIPT,
  getAddressUtxos: vi.fn(async () => ({
    utxos: [
      { outpoint: { txid: txid('b'), outIdx: 1 }, sats: 2_000n },
      { outpoint: { txid: txid('a'), outIdx: 0 }, sats: 3_000n },
      { outpoint: { txid: txid('c'), outIdx: 0 }, sats: 50_000n, token: { tokenId: 'token' } }
    ]
  })),
  ...overrides
})

describe('wallet-backed TM1 Draft 0.2 review adapter', () => {
  it('builds a public estimated snapshot with author input fixed at zero', async () => {
    const deps = dependencies()
    const snapshot = await prepareTm1Draft02Review({ eventData: '  Tonalli\n' }, deps)

    expect(deps.getAddressUtxos).toHaveBeenCalledWith(ADDRESS)
    expect(snapshot).toMatchObject({
      protocol: 'TM1',
      draft: '0.2',
      address: ADDRESS,
      authorPublicKeyHashHex: ACTIVE_PKH,
      authorInputIndex: 0,
      message: '  Tonalli\n',
      messageByteLength: 10
    })
    expect(snapshot.selectedInputs[0]).toMatchObject({
      index: 0,
      role: 'author',
      txid: txid('a'),
      outIdx: 0,
      sats: 3_000n
    })
    expect(snapshot.selectedInputs.some((input) => input.txid === txid('c'))).toBe(false)
    expect(snapshot.estimatedFeeSats).toBeGreaterThan(0n)
    expect(snapshot.estimatedFeeXec).toMatch(/^\d+\.\d{2}$/)
    expect(snapshot.estimatedChangeSats).toBeGreaterThanOrEqual(546n)
    expect(snapshot.opReturnScriptHex.startsWith('6a04544d4d00')).toBe(true)
  })

  it('fails closed when the wallet has no active address', async () => {
    const run = () => prepareTm1Draft02Review(
      { eventData: 'Tonalli' },
      dependencies({ getActiveAddress: () => null })
    )

    await expect(run).rejects.toBeInstanceOf(Tm1Draft02ReviewError)
    await expect(run).rejects.toMatchObject({ code: 'WALLET_NOT_READY' })
  })

  it('maps address conversion and Chronik failures to stable review errors', async () => {
    const cases = [
      {
        code: 'ACTIVE_ADDRESS_INVALID',
        deps: dependencies({ addressToLockingScriptHex: () => { throw new Error('bad address') } })
      },
      {
        code: 'UTXO_LOOKUP_FAILED',
        deps: dependencies({ getAddressUtxos: vi.fn(async () => { throw new Error('offline') }) })
      }
    ] as const

    for (const testCase of cases) {
      await expect(
        prepareTm1Draft02Review({ eventData: 'Tonalli' }, testCase.deps)
      ).rejects.toMatchObject({ code: testCase.code })
    }
  })
})
