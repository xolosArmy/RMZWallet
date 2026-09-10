import { describe, expect, test } from 'vitest'
import { parseTonalliMemoFeed, parseTonalliMemoTxDetail } from './guards'

const TXID = 'fadee1662482e302fcac768686085baa8f67ea9b67d846dfea100a0de1dcd9fd'
const TOKEN_ID = '8539b6f59912009f8f4fd322bf67266063233c101a4b54aa0a765ad0c9955ff8'

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

const legacyProductionVerification = {
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

const nftProductionVerification = {
  ...legacyProductionVerification,
  payload: `@nft1:${TOKEN_ID}\nMi xolo NFT`,
  displayPayload: 'Mi xolo NFT',
  attachment: {
    type: 'NFT',
    tokenId: TOKEN_ID,
    ownership: 'VERIFIED_AT_INDEXING'
  }
}

describe('Tonalli Memo production TM1 read-model contract', () => {
  test('feed composes consensus fields from transaction and protocol fields from verification (backward compatible)', () => {
    expect(parseTonalliMemoFeed({
      items: [{ transaction: productionTransaction, verification: legacyProductionVerification }],
      limit: 25
    })).toEqual({
      items: [{
        txid: TXID,
        status: 'VERIFIED',
        profileAlias: '',
        profileCode: null,
        eventType: 'POST',
        payload: 'Hello World ! Tonalli Memo is online in app.tonalli.cash wallet',
        displayPayload: 'Hello World ! Tonalli Memo is online in app.tonalli.cash wallet',
        attachment: null,
        chainStatus: 'confirmed',
        blockHeight: 965957,
        timestamp: 1788923344
      }]
    })
  })

  test('feed parses NFT attachment and displayPayload correctly when verified', () => {
    const parsed = parseTonalliMemoFeed({
      items: [{ transaction: productionTransaction, verification: nftProductionVerification }],
      limit: 25
    })
    expect(parsed).toEqual({
      items: [{
        txid: TXID,
        status: 'VERIFIED',
        profileAlias: '',
        profileCode: null,
        eventType: 'POST',
        payload: `@nft1:${TOKEN_ID}\nMi xolo NFT`,
        displayPayload: 'Mi xolo NFT',
        attachment: {
          type: 'NFT',
          tokenId: TOKEN_ID,
          ownership: 'VERIFIED_AT_INDEXING'
        },
        chainStatus: 'confirmed',
        blockHeight: 965957,
        timestamp: 1788923344
      }]
    })
  })

  test('feed parses UNVERIFIED attachment correctly', () => {
    const unverified = {
      ...nftProductionVerification,
      attachment: {
        type: 'NFT',
        tokenId: TOKEN_ID,
        ownership: 'UNVERIFIED'
      }
    }
    const parsed = parseTonalliMemoFeed({
      items: [{ transaction: productionTransaction, verification: unverified }],
      limit: 25
    })
    expect(parsed?.items[0].attachment).toEqual({
      type: 'NFT',
      tokenId: TOKEN_ID,
      ownership: 'UNVERIFIED'
    })
  })

  test('fails closed on malformed attachments', () => {
    // Malformed: non-object attachment
    expect(parseTonalliMemoFeed({
      items: [{
        transaction: productionTransaction,
        verification: { ...nftProductionVerification, attachment: 'not-an-object' }
      }]
    })).toBeNull()

    // Malformed: invalid type
    expect(parseTonalliMemoFeed({
      items: [{
        transaction: productionTransaction,
        verification: {
          ...nftProductionVerification,
          attachment: { type: 'UNKNOWN', tokenId: TOKEN_ID, ownership: 'VERIFIED_AT_INDEXING' }
        }
      }]
    })).toBeNull()

    // Malformed: invalid tokenId length or uppercase
    expect(parseTonalliMemoFeed({
      items: [{
        transaction: productionTransaction,
        verification: {
          ...nftProductionVerification,
          attachment: { type: 'NFT', tokenId: TOKEN_ID.toUpperCase(), ownership: 'VERIFIED_AT_INDEXING' }
        }
      }]
    })).toBeNull()

    // Malformed: invalid ownership enum
    expect(parseTonalliMemoFeed({
      items: [{
        transaction: productionTransaction,
        verification: {
          ...nftProductionVerification,
          attachment: { type: 'NFT', tokenId: TOKEN_ID, ownership: 'PENDING' }
        }
      }]
    })).toBeNull()

    // Malformed: displayPayload is not string
    expect(parseTonalliMemoFeed({
      items: [{
        transaction: productionTransaction,
        verification: {
          ...nftProductionVerification,
          displayPayload: 12345
        }
      }]
    })).toBeNull()
  })

  test('transaction detail accepts status only on verification and maps blockTimestamp with attachment', () => {
    expect(parseTonalliMemoTxDetail({
      transaction: productionTransaction,
      verification: nftProductionVerification
    }, TXID)).toEqual({
      txid: TXID,
      transaction: {
        txid: TXID,
        status: 'VERIFIED',
        profileAlias: '',
        profileCode: null,
        eventType: 'POST',
        payload: `@nft1:${TOKEN_ID}\nMi xolo NFT`,
        displayPayload: 'Mi xolo NFT',
        attachment: {
          type: 'NFT',
          tokenId: TOKEN_ID,
          ownership: 'VERIFIED_AT_INDEXING'
        },
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
        payload: `@nft1:${TOKEN_ID}\nMi xolo NFT`,
        displayPayload: 'Mi xolo NFT',
        attachment: {
          type: 'NFT',
          tokenId: TOKEN_ID,
          ownership: 'VERIFIED_AT_INDEXING'
        },
        chainStatus: 'confirmed',
        blockHeight: 965957,
        timestamp: 1788923344
      }
    })
  })
})
