import { describe, expect, test } from 'vitest'
import { parseTonalliMemoFeed, parseTonalliMemoTxDetail } from './guards'

const TXID = 'fadee1662482e302fcac768686085baa8f67ea9b67d846dfea100a0de1dcd9fd'

const productionTransaction = {
  txid: TXID,
  chainStatus: 'confirmed',
  isCoinbase: false,
  isFinal: true,
  blockHeight: 965957,
  blockHash: '00000000000000003b25b96ec23a48cfb9adc5c32f6a17854c4a1e48635e9d49',
  blockTimestamp: 1788923344,
  firstSeenAt: null,
  firstIndexedAt: 1789054211,
  updatedAt: 1789054211
}

const productionVerification = {
  txid: TXID,
  status: 'VERIFIED',
  protocol: 'TM1',
  protocolVersion: 1,
  eventType: 'POST',
  profileCode: null,
  payload: 'Hello World ! Tonalli Memo is online in app.tonalli.cash wallet',
  byteLength: 63,
  candidate: { protocol: 'TM1', outputIndex: 0 },
  authorizingAddress: 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk',
  authorizingInputIndex: 0,
  evaluationHeight: null,
  tm1Authorship: {
    publicKeyHashHex: '3c0995f962a39c760b06e67ec1efe1f780d56284',
    sighashByte: 65,
    trustModel: 'trusted-chronik'
  },
  firstIndexedAt: 1789054211,
  lastVerifiedAt: 1789054211
}

describe('Tonalli Memo production TM1 read-model contract', () => {
  test('feed composes consensus fields from transaction and protocol fields from verification', () => {
    expect(parseTonalliMemoFeed({
      items: [{ transaction: productionTransaction, verification: productionVerification }],
      limit: 25
    })).toEqual({
      items: [{
        txid: TXID,
        status: 'VERIFIED',
        profileAlias: '',
        profileCode: null,
        eventType: 'POST',
        payload: 'Hello World ! Tonalli Memo is online in app.tonalli.cash wallet',
        chainStatus: 'confirmed',
        blockHeight: 965957,
        timestamp: 1788923344
      }]
    })
  })

  test('transaction detail accepts status only on verification and maps blockTimestamp', () => {
    expect(parseTonalliMemoTxDetail({
      transaction: productionTransaction,
      verification: productionVerification
    }, TXID)).toEqual({
      txid: TXID,
      transaction: {
        txid: TXID,
        status: 'VERIFIED',
        profileAlias: '',
        profileCode: null,
        eventType: 'POST',
        payload: 'Hello World ! Tonalli Memo is online in app.tonalli.cash wallet',
        chainStatus: 'confirmed',
        blockHeight: 965957,
        timestamp: 1788923344
      },
      verification: {
        txid: TXID,
        status: 'VERIFIED',
        profileAlias: '',
        profileCode: null,
        eventType: 'POST',
        payload: 'Hello World ! Tonalli Memo is online in app.tonalli.cash wallet',
        chainStatus: 'confirmed',
        blockHeight: 965957,
        timestamp: 1788923344
      }
    })
  })
})
