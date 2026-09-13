import { describe, expect, it } from 'vitest'
import {
  COINBASE_MATURITY_CONFIRMATIONS,
  isImmatureCoinbaseUtxo
} from './coinbaseMaturity'

describe('canonical coinbase maturity predicate', () => {
  const blockHeight = 800_000
  const firstMatureTip = blockHeight + COINBASE_MATURITY_CONFIRMATIONS - 1

  it('excludes immature coinbase', () => {
    expect(
      isImmatureCoinbaseUtxo({ isCoinbase: true, blockHeight }, blockHeight + 50)
    ).toBe(true)
  })

  it('excludes the height immediately before maturity', () => {
    expect(
      isImmatureCoinbaseUtxo({ isCoinbase: true, blockHeight }, firstMatureTip - 1)
    ).toBe(true)
  })

  it('allows the first valid mature height according to the repository rule', () => {
    expect(firstMatureTip - blockHeight + 1).toBe(COINBASE_MATURITY_CONFIRMATIONS)
    expect(
      isImmatureCoinbaseUtxo({ isCoinbase: true, blockHeight }, firstMatureTip)
    ).toBe(false)
  })

  it('allows a mature coinbase', () => {
    expect(
      isImmatureCoinbaseUtxo({ isCoinbase: true, blockHeight }, firstMatureTip + 25)
    ).toBe(false)
  })

  it('excludes coinbase with missing blockHeight', () => {
    expect(isImmatureCoinbaseUtxo({ isCoinbase: true }, 900_000)).toBe(true)
  })

  it('excludes mempool coinbase (blockHeight < 0)', () => {
    expect(isImmatureCoinbaseUtxo({ isCoinbase: true, blockHeight: -1 }, 900_000)).toBe(true)
  })

  it('excludes coinbase when tip height is unavailable', () => {
    expect(isImmatureCoinbaseUtxo({ isCoinbase: true, blockHeight }, undefined)).toBe(true)
  })

  it('does not treat non-coinbase UTXOs as immature', () => {
    expect(isImmatureCoinbaseUtxo({ isCoinbase: false, blockHeight: 1 }, undefined)).toBe(false)
    expect(isImmatureCoinbaseUtxo({ blockHeight: 1 }, undefined)).toBe(false)
  })
})
