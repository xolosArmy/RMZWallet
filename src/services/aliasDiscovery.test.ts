// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { discoverAliasForAddress, extractAliasFromOutputScript } from './aliasDiscovery'

describe('aliasDiscovery service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('extractAliasFromOutputScript', () => {
    it('returns null for empty or non-string input', () => {
      expect(extractAliasFromOutputScript('')).toBeNull()
      // @ts-expect-error testing invalid type
      expect(extractAliasFromOutputScript(null)).toBeNull()
      // @ts-expect-error testing invalid type
      expect(extractAliasFromOutputScript(undefined)).toBeNull()
    })

    it('returns null if script does not contain alias lokad prefix', () => {
      // Regular OP_RETURN or P2PKH script
      expect(extractAliasFromOutputScript('6a0464617461')).toBeNull()
      expect(extractAliasFromOutputScript('76a914abcdef88ac')).toBeNull()
    })

    it('successfully extracts and decodes a canonical .xec alias from script hex', () => {
      // Alias 'satoshi':
      // 6a 04 2e786563 00 07 7361746f736869 15 <21 bytes address payload>
      const aliasHex = Buffer.from('satoshi', 'utf8').toString('hex')
      const scriptHex = `6a042e7865630007${aliasHex}1500112233445566778899aabbccddeeff00112233`
      expect(extractAliasFromOutputScript(scriptHex)).toBe('satoshi.xec')
    })

    it('handles uppercase hex and extracts valid alias', () => {
      const aliasHex = Buffer.from('tonalli', 'utf8').toString('hex').toUpperCase()
      const scriptHex = `6A042E7865630007${aliasHex}1500112233445566778899AABBCCDDEEFF00112233`
      expect(extractAliasFromOutputScript(scriptHex)).toBe('tonalli.xec')
    })

    it('returns null if extracted alias contains invalid characters', () => {
      // Contains invalid characters (e.g. spaces or uppercase non-alphanumeric)
      const invalidHex = Buffer.from('invalid alias!', 'utf8').toString('hex')
      const lenHex = invalidHex.length / 2 < 16 ? `0${(invalidHex.length / 2).toString(16)}` : (invalidHex.length / 2).toString(16)
      const scriptHex = `6a042e78656300${lenHex}${invalidHex}15001122`
      expect(extractAliasFromOutputScript(scriptHex)).toBeNull()
    })
  })

  describe('discoverAliasForAddress', () => {
    const testAddress = 'ecash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cacy2kzvq'

    it('returns alias from walletService.findAliasForAddress if available', async () => {
      const mockService = {
        findAliasForAddress: vi.fn().mockResolvedValue('custom.xec')
      }
      const alias = await discoverAliasForAddress(testAddress, undefined, mockService)
      expect(alias).toBe('custom.xec')
      expect(mockService.findAliasForAddress).toHaveBeenCalledWith(testAddress)
    })

    it('discovers alias by parsing Chronik address transaction history', async () => {
      const aliasHex = Buffer.from('alex', 'utf8').toString('hex')
      const scriptHex = `6a042e7865630004${aliasHex}1500112233445566778899aabbccddeeff00112233`
      const mockChronik = {
        address: vi.fn().mockReturnValue({
          history: vi.fn().mockResolvedValue({
            txs: [
              {
                txid: 'tx1',
                outputs: [
                  { outputScript: scriptHex }
                ]
              }
            ]
          })
        })
      }

      const alias = await discoverAliasForAddress(testAddress, mockChronik, {})
      expect(alias).toBe('alex.xec')
    })

    it('discovers alias via chronik.lookupAliasByAddress method', async () => {
      const mockChronik = {
        lookupAliasByAddress: vi.fn().mockResolvedValue('lookup.xec')
      }
      const alias = await discoverAliasForAddress(testAddress, mockChronik, {})
      expect(alias).toBe('lookup.xec')
    })

    it('returns null if neither chronik nor services find any alias', async () => {
      const mockChronik = {
        address: vi.fn().mockReturnValue({
          history: vi.fn().mockResolvedValue({ txs: [] })
        })
      }
      const alias = await discoverAliasForAddress(testAddress, mockChronik, {})
      expect(alias).toBeNull()
    })
  })
})
