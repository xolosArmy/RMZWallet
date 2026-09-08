// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  discoverAliasForAddress,
  extractAliasFromOutputScript,
  getAddressPayloadHex,
  extractOwnerAddressFromScript
} from './aliasDiscovery'

describe('aliasDiscovery service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getAddressPayloadHex and extractOwnerAddressFromScript', () => {
    const addr = 'ecash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cacy2kzvq'

    it('correctly calculates 21-byte payload hex for p2pkh address', () => {
      const payload = getAddressPayloadHex(addr)
      expect(payload).toBe('00751e76e8199196d454941c45d1b3a323f1433bd6')
      expect(payload?.length).toBe(42)
    })

    it('extracts owner address back from script hex', () => {
      const aliasHex = Buffer.from('satoshi', 'utf8').toString('hex')
      const payload = getAddressPayloadHex(addr)
      const scriptHex = `6a042e7865630007${aliasHex}15${payload}`
      const extractedAddr = extractOwnerAddressFromScript(scriptHex)
      expect(extractedAddr).toBe(addr)
    })
  })

  describe('extractAliasFromOutputScript', () => {
    const addr = 'ecash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cacy2kzvq'
    const otherAddr = 'ecash:qz2708636snqhsxu8wnlka78h6fdp77ar59jrf5035'

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

    it('successfully extracts and decodes a canonical .xec alias from script hex without expectedAddress', () => {
      // Alias 'satoshi':
      // 6a 04 2e786563 00 07 7361746f736869 15 <21 bytes address payload>
      const aliasHex = Buffer.from('satoshi', 'utf8').toString('hex')
      const scriptHex = `6a042e7865630007${aliasHex}1500112233445566778899aabbccddeeff00112233`
      expect(extractAliasFromOutputScript(scriptHex)).toBe('satoshi.xec')
    })

    it('Finding 1: validates embedded owner matches expectedAddress', () => {
      const aliasHex = Buffer.from('satoshi', 'utf8').toString('hex')
      const addrPayload = getAddressPayloadHex(addr)
      const scriptHex = `6a042e7865630007${aliasHex}15${addrPayload}`

      // Matching address returns alias
      expect(extractAliasFromOutputScript(scriptHex, addr)).toBe('satoshi.xec')

      // Mismatched address returns null
      expect(extractAliasFromOutputScript(scriptHex, otherAddr)).toBeNull()
    })

    it('Finding 1: returns null if expectedAddress specified but owner payload is truncated or invalid', () => {
      const aliasHex = Buffer.from('satoshi', 'utf8').toString('hex')
      // Missing push 15 or truncated payload
      const scriptHexTruncated = `6a042e7865630007${aliasHex}15001122`
      expect(extractAliasFromOutputScript(scriptHexTruncated, addr)).toBeNull()

      const scriptHexNoPush15 = `6a042e7865630007${aliasHex}1400112233445566778899aabbccddeeff001122`
      expect(extractAliasFromOutputScript(scriptHexNoPush15, addr)).toBeNull()
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
    const otherAddress = 'ecash:qz2708636snqhsxu8wnlka78h6fdp77ar59jrf5035'

    it('returns alias from walletService.findAliasForAddress if available', async () => {
      const mockService = {
        findAliasForAddress: vi.fn().mockResolvedValue('custom.xec')
      }
      const alias = await discoverAliasForAddress(testAddress, undefined, mockService)
      expect(alias).toBe('custom.xec')
      expect(mockService.findAliasForAddress).toHaveBeenCalledWith(testAddress)
    })

    it('discovers alias by parsing Chronik address transaction history with matching embedded owner', async () => {
      const aliasHex = Buffer.from('alex', 'utf8').toString('hex')
      const addrPayload = getAddressPayloadHex(testAddress)
      const scriptHex = `6a042e7865630004${aliasHex}15${addrPayload}`
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

    it('Strict Rule 1: ignores transaction where OP_RETURN belongs to another address even if returned in history', async () => {
      const aliasHex = Buffer.from('bobthebuilder', 'utf8').toString('hex')
      // Embedded owner belongs to otherAddress, NOT testAddress!
      const otherPayload = getAddressPayloadHex(otherAddress)
      const foreignScriptHex = `6a042e786563000d${aliasHex}15${otherPayload}`

      const mockChronik = {
        address: vi.fn().mockReturnValue({
          history: vi.fn().mockResolvedValue({
            txs: [
              {
                txid: 'foreign-tx',
                outputs: [
                  // Foreign OP_RETURN alias output
                  { outputScript: foreignScriptHex },
                  // Active wallet was merely a recipient in output 1
                  { outputScript: '76a914751e76e8199196d454941c45d1b3a323f1433bd688ac' }
                ]
              }
            ]
          })
        })
      }

      // Querying for testAddress must ignore foreignScriptHex and return null!
      const alias = await discoverAliasForAddress(testAddress, mockChronik, {})
      expect(alias).toBeNull()

      // Querying for otherAddress must successfully discover bobthebuilder.xec!
      const aliasForOther = await discoverAliasForAddress(otherAddress, mockChronik, {})
      expect(aliasForOther).toBe('bobthebuilder.xec')
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
