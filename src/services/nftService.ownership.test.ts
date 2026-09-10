import { describe, expect, test, vi, beforeEach } from 'vitest'
import { isNftChildUtxo, ownsNftChildToken } from './nftService'
import * as chronikClientModule from './ChronikClient'
import type { ScriptUtxo } from 'chronik-client'

describe('ownsNftChildToken & isNftChildUtxo (lightweight JIT check)', () => {
  const address = 'ecash:qqtest1234567890'
  const tokenId = '8539b6f59912009f8f4fd322bf67266063233c101a4b54aa0a765ad0c9955ff8'

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  test('isNftChildUtxo verifies SLP NFT1 Child with 1 atom', () => {
    const validUtxo = {
      tx_hash: 'a'.repeat(64),
      out_idx: 0,
      value: 546n,
      token: {
        tokenId,
        tokenType: { protocol: 'SLP', type: 'SLP_TOKEN_TYPE_NFT1_CHILD', number: 65 },
        isMintBaton: false,
        atoms: 1n
      }
    } as unknown as ScriptUtxo

    expect(isNftChildUtxo(validUtxo)).toBe(true)

    // protocol SLP + number 65 pero type distinto => false
    expect(isNftChildUtxo({
      ...validUtxo,
      token: { ...validUtxo.token!, tokenType: { protocol: 'SLP', type: 'SLP_TOKEN_TYPE_UNKNOWN', number: 65 } }
    } as unknown as ScriptUtxo)).toBe(false)

    // Not NFT1 Child (wrong number)
    expect(isNftChildUtxo({
      ...validUtxo,
      token: { ...validUtxo.token!, tokenType: { protocol: 'SLP', type: 'SLP_TOKEN_TYPE_NFT1_CHILD', number: 1 } }
    } as unknown as ScriptUtxo)).toBe(false)

    // Mint baton
    expect(isNftChildUtxo({
      ...validUtxo,
      token: { ...validUtxo.token!, isMintBaton: true }
    } as unknown as ScriptUtxo)).toBe(false)

    // Not 1 atom
    expect(isNftChildUtxo({
      ...validUtxo,
      token: { ...validUtxo.token!, atoms: 2n }
    } as unknown as ScriptUtxo)).toBe(false)

    // No token
    expect(isNftChildUtxo({ tx_hash: 'a'.repeat(64), out_idx: 0, value: 546n } as unknown as ScriptUtxo)).toBe(false)
  })

  test('ownsNftChildToken returns true when child UTXO is present in Chronik', async () => {
    const mockChronik = {
      address: vi.fn().mockReturnValue({
        utxos: vi.fn().mockResolvedValue({
          utxos: [
            {
              token: {
                tokenId: tokenId.toUpperCase(), // case insensitive check
                tokenType: { protocol: 'SLP', type: 'SLP_TOKEN_TYPE_NFT1_CHILD', number: 65 },
                isMintBaton: false,
                atoms: 1n
              }
            }
          ]
        })
      })
    }
    vi.spyOn(chronikClientModule, 'getChronik').mockReturnValue(mockChronik as unknown as ReturnType<typeof chronikClientModule.getChronik>)

    const result = await ownsNftChildToken(address, tokenId)
    expect(result).toBe(true)
    expect(mockChronik.address).toHaveBeenCalledWith(address)
  })

  test('ownsNftChildToken returns false when tokenId is not in UTXOs', async () => {
    const mockChronik = {
      address: vi.fn().mockReturnValue({
        utxos: vi.fn().mockResolvedValue({
          utxos: [
            {
              token: {
                tokenId: 'other-id',
                tokenType: { protocol: 'SLP', number: 65 },
                isMintBaton: false,
                atoms: 1n
              }
            }
          ]
        })
      })
    }
    vi.spyOn(chronikClientModule, 'getChronik').mockReturnValue(mockChronik as unknown as ReturnType<typeof chronikClientModule.getChronik>)

    const result = await ownsNftChildToken(address, tokenId)
    expect(result).toBe(false)
  })

  test('ownsNftChildToken fails closed when Chronik throws an error', async () => {
    const mockChronik = {
      address: vi.fn().mockReturnValue({
        utxos: vi.fn().mockRejectedValue(new Error('Chronik offline'))
      })
    }
    vi.spyOn(chronikClientModule, 'getChronik').mockReturnValue(mockChronik as unknown as ReturnType<typeof chronikClientModule.getChronik>)

    const result = await ownsNftChildToken(address, tokenId)
    expect(result).toBe(false)
  })

  test('ownsNftChildToken returns false on empty inputs', async () => {
    expect(await ownsNftChildToken('', tokenId)).toBe(false)
    expect(await ownsNftChildToken(address, '')).toBe(false)
  })
})
