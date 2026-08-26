import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { ScriptUtxo, Tx } from 'chronik-client'
import type { XolosWalletService } from './XolosWalletService'

const OFFICIAL_PARENT_TOKEN_ID =
  'bf8e0b5cd60fe4d6354c662b28542e0f3c3d69941eb039426d65bcdb7fe9f48c'
const COMMUNITY_PARENT_TOKEN_ID =
  'd6ff881413733a1a6407fa5e1e86537e5fc9f48246bae89b732ca7044993e57a'
const OFFER_TXID = '1'.repeat(64)

const mocks = vi.hoisted(() => ({
  chronikTx: vi.fn(),
  chronikAddressUtxos: vi.fn(),
  chronikBroadcast: vi.fn(),
  parseAgoraTx: vi.fn(),
  getSignatory: vi.fn(),
  withPrivateKey: vi.fn()
}))

vi.mock('./ChronikClient', () => ({
  getChronik: () => ({
    tx: mocks.chronikTx,
    address: () => ({ utxos: mocks.chronikAddressUtxos }),
    broadcastTx: mocks.chronikBroadcast
  })
}))

vi.mock('ecash-agora', async () => {
  const actual = await vi.importActual<typeof import('ecash-agora')>('ecash-agora')
  return { ...actual, parseAgoraTx: mocks.parseAgoraTx }
})

import { acceptOfferById } from './agoraExchange'

const offerTx = (tokenId: string) =>
  ({
    outputs: [
      {},
      {
        token: {
          tokenId,
          tokenType: {
            protocol: 'SLP',
            type: 'SLP_TOKEN_TYPE_NFT1_GROUP',
            number: 129
          },
          atoms: 1n,
          isMintBaton: false
        }
      }
    ]
  }) as unknown as Tx

const wallet = {
  getSignatory: mocks.getSignatory,
  withPrivateKey: mocks.withPrivateKey
} as unknown as XolosWalletService

describe('acceptOfferById canonical Mint Pass boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.parseAgoraTx.mockReturnValue({
      type: 'ONESHOT',
      outpoint: { txid: OFFER_TXID, outIdx: 1 },
      params: {}
    })
    mocks.chronikAddressUtxos.mockResolvedValue({ utxos: [] as ScriptUtxo[] })
  })

  test.each([
    ['Community summary but Official reload', 'community', OFFICIAL_PARENT_TOKEN_ID],
    ['Official summary but Community reload', 'official', COMMUNITY_PARENT_TOKEN_ID]
  ] as const)(
    'rejects %s before signatory/private-key/broadcast',
    async (_label, expectedCollectionId, observedTokenId) => {
      mocks.chronikTx.mockResolvedValue(offerTx(observedTokenId))

      await expect(
        acceptOfferById({
          offerId: `${OFFER_TXID}:1`,
          wallet,
          expectedCollectionId
        })
      ).rejects.toThrow('no corresponde al token esperado')

      expect(mocks.getSignatory).not.toHaveBeenCalled()
      expect(mocks.withPrivateKey).not.toHaveBeenCalled()
      expect(mocks.chronikAddressUtxos).not.toHaveBeenCalled()
      expect(mocks.chronikBroadcast).not.toHaveBeenCalled()
    }
  )

  test('rejects a hostile runtime collection before even loading the offer', async () => {
    await expect(
      acceptOfferById({
        offerId: `${OFFER_TXID}:1`,
        wallet,
        expectedCollectionId: 'attacker-parent' as 'community'
      })
    ).rejects.toThrow('Colección NFT no registrada.')

    expect(mocks.chronikTx).not.toHaveBeenCalled()
    expect(mocks.getSignatory).not.toHaveBeenCalled()
    expect(mocks.withPrivateKey).not.toHaveBeenCalled()
    expect(mocks.chronikBroadcast).not.toHaveBeenCalled()
  })

  test('ignores a raw token-id injection and still derives authority from CollectionId', async () => {
    mocks.chronikTx.mockResolvedValue(offerTx(OFFICIAL_PARENT_TOKEN_ID))

    await expect(
      acceptOfferById({
        offerId: `${OFFER_TXID}:1`,
        wallet,
        expectedCollectionId: 'community',
        expectedTokenId: OFFICIAL_PARENT_TOKEN_ID
      } as Parameters<typeof acceptOfferById>[0] & { expectedTokenId: string })
    ).rejects.toThrow('no corresponde al token esperado')

    expect(mocks.getSignatory).not.toHaveBeenCalled()
    expect(mocks.withPrivateKey).not.toHaveBeenCalled()
    expect(mocks.chronikBroadcast).not.toHaveBeenCalled()
  })
})
