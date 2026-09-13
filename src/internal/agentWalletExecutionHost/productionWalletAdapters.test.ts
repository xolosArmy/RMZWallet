import { describe, expect, it } from 'vitest'
import { COINBASE_MATURITY_CONFIRMATIONS } from '../../services/coinbaseMaturity'
import { selectSpendableXecUtxosForExecution } from './productionWalletAdapters'

const SCRIPT = '76a91479b000887626b294a914501a4cd226b58b23598388ac'
const TXID = 'aa'.repeat(32)

function utxo(overrides: {
  outIdx?: number
  sats?: bigint
  token?: unknown
  isCoinbase?: boolean
  blockHeight?: number
}) {
  return {
    outpoint: { txid: TXID, outIdx: overrides.outIdx ?? 0 },
    sats: overrides.sats ?? 100_000n,
    token: overrides.token,
    isCoinbase: overrides.isCoinbase,
    blockHeight: overrides.blockHeight
  }
}

describe('production spendable UTXO selection', () => {
  const blockHeight = 800_000
  const firstMatureTip = blockHeight + COINBASE_MATURITY_CONFIRMATIONS - 1

  it('excludes immature coinbase and keeps non-coinbase', () => {
    const selected = selectSpendableXecUtxosForExecution(
      [
        utxo({ isCoinbase: true, blockHeight, sats: 50_000_000_000n }),
        utxo({ outIdx: 1, isCoinbase: false, sats: 200_000n })
      ],
      SCRIPT,
      blockHeight + 50
    )
    expect(selected).toHaveLength(1)
    expect(selected[0]?.outIdx).toBe(1)
  })

  it('excludes the coinbase immediately before maturity', () => {
    const selected = selectSpendableXecUtxosForExecution(
      [utxo({ isCoinbase: true, blockHeight })],
      SCRIPT,
      firstMatureTip - 1
    )
    expect(selected).toHaveLength(0)
  })

  it('allows the first valid mature coinbase height', () => {
    const selected = selectSpendableXecUtxosForExecution(
      [utxo({ isCoinbase: true, blockHeight, sats: 125_000n })],
      SCRIPT,
      firstMatureTip
    )
    expect(selected).toHaveLength(1)
    expect(selected[0]?.sats).toBe(125_000n)
  })

  it('allows a mature coinbase', () => {
    const selected = selectSpendableXecUtxosForExecution(
      [utxo({ isCoinbase: true, blockHeight })],
      SCRIPT,
      firstMatureTip + 10
    )
    expect(selected).toHaveLength(1)
  })

  it('excludes coinbase with missing blockHeight', () => {
    const selected = selectSpendableXecUtxosForExecution(
      [utxo({ isCoinbase: true })],
      SCRIPT,
      900_000
    )
    expect(selected).toHaveLength(0)
  })

  it('excludes coinbase when tip height is unavailable', () => {
    const selected = selectSpendableXecUtxosForExecution(
      [utxo({ isCoinbase: true, blockHeight }), utxo({ outIdx: 1, isCoinbase: false })],
      SCRIPT,
      undefined
    )
    expect(selected.map(item => item.outIdx)).toEqual([1])
  })

  it('keeps token-bearing exclusions intact', () => {
    const selected = selectSpendableXecUtxosForExecution(
      [
        utxo({ token: { tokenId: 'rmz' }, isCoinbase: false }),
        utxo({ outIdx: 1, isCoinbase: false, sats: 90_000n })
      ],
      SCRIPT,
      900_000
    )
    expect(selected).toHaveLength(1)
    expect(selected[0]?.outIdx).toBe(1)
  })
})
