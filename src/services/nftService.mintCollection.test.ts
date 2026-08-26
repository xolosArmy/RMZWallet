import { beforeEach, describe, expect, test, vi } from 'vitest'

const OFFICIAL_PARENT_TOKEN_ID =
  'bf8e0b5cd60fe4d6354c662b28542e0f3c3d69941eb039426d65bcdb7fe9f48c'
const COMMUNITY_PARENT_TOKEN_ID =
  'd6ff881413733a1a6407fa5e1e86537e5fc9f48246bae89b732ca7044993e57a'
const CHILD_TOKEN_ID = 'c'.repeat(64)

const mocks = vi.hoisted(() => ({
  assertMintPass: vi.fn(),
  mintGenesis: vi.fn(),
  uploadFile: vi.fn(),
  uploadJson: vi.fn(),
  buildMetadata: vi.fn(),
  getAddress: vi.fn(),
  getSignatory: vi.fn(),
  withPrivateKey: vi.fn()
}))

vi.mock('./slpNftTxBuilder', () => ({
  assertNftChildMintPassAvailable: mocks.assertMintPass,
  mintNftChildGenesis: mocks.mintGenesis,
  sendNftChild: vi.fn()
}))

vi.mock('./pinata', () => ({
  uploadFileToPinata: mocks.uploadFile,
  uploadJsonToPinata: mocks.uploadJson
}))

vi.mock('./nftMetadata', () => ({
  buildXolosarmyNftMetadata: mocks.buildMetadata
}))

vi.mock('./XolosWalletService', () => ({
  xolosWalletService: {
    getAddress: mocks.getAddress,
    getSignatory: mocks.getSignatory,
    withPrivateKey: mocks.withPrivateKey
  }
}))

import { mintXolosarmyNftChild } from './nftService'

const imageFile = { name: 'community.png' } as File

describe('mintXolosarmyNftChild collection boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getAddress.mockReturnValue('ecash:qptest')
    mocks.getSignatory.mockReturnValue({
      address: 'ecash:qptest',
      publicKeyHex: '02'.padEnd(66, '1')
    })
    mocks.assertMintPass.mockResolvedValue({
      kind: 'exact',
      parentTokenId: COMMUNITY_PARENT_TOKEN_ID,
      utxo: {}
    })
    mocks.uploadFile.mockResolvedValue({ cid: 'bafy-image' })
    mocks.uploadJson.mockResolvedValue({ cid: 'bafy-metadata' })
    mocks.buildMetadata.mockReturnValue({ name: 'fixture' })
    mocks.mintGenesis.mockResolvedValue({ txid: CHILD_TOKEN_ID })
    mocks.withPrivateKey.mockImplementation(async (operation: (key: Uint8Array) => unknown) =>
      operation(new Uint8Array([1, 2, 3]))
    )
  })

  test('fails before metadata upload or private-key access when the selected pass is missing', async () => {
    mocks.assertMintPass.mockRejectedValue(
      new Error('Necesitas al menos 1 Mint Pass de la colección seleccionada para mintear.')
    )

    await expect(
      mintXolosarmyNftChild({
        collectionId: 'community',
        name: 'Hostile Official claim',
        description: 'Metadata cannot establish trust',
        imageFile
      })
    ).rejects.toThrow('Mint Pass de la colección seleccionada')

    expect(mocks.assertMintPass).toHaveBeenCalledExactlyOnceWith({
      address: 'ecash:qptest',
      collectionId: 'community'
    })
    expect(mocks.uploadFile).not.toHaveBeenCalled()
    expect(mocks.uploadJson).not.toHaveBeenCalled()
    expect(mocks.getSignatory).not.toHaveBeenCalled()
    expect(mocks.withPrivateKey).not.toHaveBeenCalled()
    expect(mocks.mintGenesis).not.toHaveBeenCalled()
  })

  test.each([
    ['official', OFFICIAL_PARENT_TOKEN_ID],
    ['community', COMMUNITY_PARENT_TOKEN_ID]
  ] as const)('plumbs %s explicitly through metadata and the NFT1 builder', async (collectionId, parentTokenId) => {
    mocks.assertMintPass.mockResolvedValue({
      kind: 'exact',
      parentTokenId,
      utxo: {}
    })

    await mintXolosarmyNftChild({
      collectionId,
      name: 'Xolos Ramírez Official',
      description: 'verification=verified parentTokenId=attacker',
      imageFile,
      externalUrl: 'ipfs://metadata-cannot-select-trust'
    })

    expect(mocks.buildMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ collectionId, name: 'Xolos Ramírez Official' })
    )
    expect(mocks.mintGenesis).toHaveBeenCalledWith(
      expect.objectContaining({ collectionId })
    )
    expect(mocks.withPrivateKey).toHaveBeenCalledTimes(1)
  })

  test('rejects a runtime free-form collection before uploads or private-key access', async () => {
    await expect(
      mintXolosarmyNftChild({
        collectionId: 'attacker-parent' as 'community',
        name: 'Attacker',
        description: 'Attacker',
        imageFile
      })
    ).rejects.toThrow('Colección NFT no registrada.')

    expect(mocks.assertMintPass).not.toHaveBeenCalled()
    expect(mocks.uploadFile).not.toHaveBeenCalled()
    expect(mocks.withPrivateKey).not.toHaveBeenCalled()
  })
})
