import assert from 'node:assert/strict'
import test from 'node:test'
import { extractOutpointsFromUnsignedTxHex } from './externalSign.ts'

test('extractOutpointsFromUnsignedTxHex deriva txid y vout desde unsignedTxHex', () => {
  const unsignedTxHex =
    '0100000001aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0100000000ffffffff01e803000000000000015100000000'

  const outpoints = extractOutpointsFromUnsignedTxHex(unsignedTxHex)

  assert.equal(outpoints.length, 1)
  assert.equal(outpoints[0].txid, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  assert.equal(outpoints[0].vout, 1)
})
