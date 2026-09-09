import { decodeCashAddress, encodeCashAddress } from 'ecashaddrjs'
import { getChronik } from './ChronikClient'

/**
 * Computes the 21-byte address payload hex (1 byte type + 20 bytes hash160 = 42 hex characters).
 * P2PKH -> '00' + hash160
 * P2SH  -> '08' + hash160
 */
export function getAddressPayloadHex(address: string): string | null {
  if (typeof address !== 'string' || !address.trim()) return null
  try {
    const cleanAddr = address.trim()
    const decoded = decodeCashAddress(cleanAddr)
    const typeByte = decoded.type === 'p2pkh' ? '00' : (decoded.type === 'p2sh' ? '08' : null)
    if (!typeByte || !decoded.hash || decoded.hash.length !== 40) return null
    return `${typeByte}${decoded.hash.toLowerCase()}`
  } catch {
    return null
  }
}

/**
 * Extracts and decodes the embedded owner address from an alias registration OP_RETURN script.
 */
export function extractOwnerAddressFromScript(
  scriptHex: string,
  prefix: 'ecash' | 'ecregtest' | 'ectest' = 'ecash'
): string | null {
  if (typeof scriptHex !== 'string') return null
  const hex = scriptHex.toLowerCase()
  const prefixHex = '6a042e78656300'
  const idx = hex.indexOf(prefixHex)
  if (idx === -1) return null

  const remainder = hex.slice(idx + prefixHex.length)
  if (remainder.length < 2) return null

  const lenByte = parseInt(remainder.slice(0, 2), 16)
  if (isNaN(lenByte) || lenByte < 1 || lenByte > 21) return null
  if (remainder.length < 2 + lenByte * 2 + 44) return null

  const postAlias = remainder.slice(2 + lenByte * 2)
  if (!postAlias.startsWith('15')) return null

  const payload = postAlias.slice(2, 44)
  const typeByte = payload.slice(0, 2)
  const hash = payload.slice(2, 42)
  const type = typeByte === '00' ? 'p2pkh' : (typeByte === '08' ? 'p2sh' : null)
  if (!type) return null

  try {
    return encodeCashAddress(prefix, type, hash)
  } catch {
    return null
  }
}

/**
 * Extracts an eCash .xec alias from an OP_RETURN script hex if present.
 * Format for eCash alias protocol registration:
 * 6a 04 2e786563 00 <lenByte> <aliasHex> 15 <addressPayload>
 * - 6a: OP_RETURN
 * - 04: PUSHDATA(4)
 * - 2e786563: Lokad ID for ".xec"
 * - 00: protocol version 0
 * - lenByte: length of alias in bytes (1 to 21)
 * - aliasHex: UTF-8 encoded alias name
 * - 15: PUSHDATA(21)
 * - addressPayload: 21 bytes (1 byte type + 20 bytes hash160)
 *
 * If expectedAddress is provided, verifies that the embedded 21-byte owner payload
 * cryptographically matches the expectedAddress.
 */
export function extractAliasFromOutputScript(
  scriptHex: string,
  expectedAddress?: string
): string | null {
  if (typeof scriptHex !== 'string') return null
  const hex = scriptHex.toLowerCase()
  const prefix = '6a042e78656300'
  const idx = hex.indexOf(prefix)
  if (idx === -1) return null

  const remainder = hex.slice(idx + prefix.length)
  if (remainder.length < 2) return null

  const lenByte = parseInt(remainder.slice(0, 2), 16)
  if (isNaN(lenByte) || lenByte < 1 || lenByte > 21) return null
  if (remainder.length < 2 + lenByte * 2) return null

  const aliasHex = remainder.slice(2, 2 + lenByte * 2)
  let name = ''
  for (let i = 0; i < aliasHex.length; i += 2) {
    name += String.fromCharCode(parseInt(aliasHex.slice(i, i + 2), 16))
  }

  const cleanName = name.trim().toLowerCase()
  if (!cleanName || !/^[a-z0-9]{1,21}$/.test(cleanName)) return null

  // Finding 1 (Verify embedded owner - P2):
  // When expectedAddress is specified, extract and validate the 21-byte owner payload.
  // Only return the alias if the embedded owner cryptographically matches expectedAddress.
  const postAlias = remainder.slice(2 + lenByte * 2)
  if (expectedAddress) {
    if (postAlias.length < 44 || !postAlias.startsWith('15')) {
      return null
    }
    const embeddedPayload = postAlias.slice(2, 44)
    const expectedPayload = getAddressPayloadHex(expectedAddress)
    if (!expectedPayload || embeddedPayload !== expectedPayload) {
      return null
    }
  }

  return `${cleanName}.xec`
}

/**
 * Discovers if an address possesses an on-chain registered .xec alias.
 * Queries Chronik history or alias indexer / service.
 */
export async function discoverAliasForAddress(
  address: string | null | undefined,
  chronikClient?: any,
  walletService?: any
): Promise<string | null> {
  if (!address || typeof address !== 'string') return null

  // 1. Direct query on walletService if custom mocked/provided in test harness or context
  try {
    const customService = walletService
    if (
      customService &&
      typeof customService.findAliasForAddress === 'function'
    ) {
      const found = await customService.findAliasForAddress(address)
      if (typeof found === 'string' && found) {
        return found.endsWith('.xec') ? found : `${found}.xec`
      }
    }
  } catch {
    // continue to chronik / service fallback
  }

  // 2. Query Chronik client
  try {
    const chronik =
      chronikClient ?? (typeof getChronik === 'function' ? getChronik() : undefined)
    if (chronik) {
      if (typeof chronik.lookupAliasByAddress === 'function') {
        const found = await chronik.lookupAliasByAddress(address)
        if (typeof found === 'string' && found) {
          return found.endsWith('.xec') ? found : `${found}.xec`
        }
      }
      if (typeof chronik.getAliasForAddress === 'function') {
        const found = await chronik.getAliasForAddress(address)
        if (typeof found === 'string' && found) {
          return found.endsWith('.xec') ? found : `${found}.xec`
        }
      }

      // Query address history if available (paginate through history pages)
      if (typeof chronik.address === 'function') {
        try {
          const pageSize = 20
          let page = 0
          let totalPages = 1
          const MAX_PAGES = 50

          while (page < totalPages && page < MAX_PAGES) {
            const res = await chronik.address(address).history(page, pageSize)
            if (typeof res?.numPages === 'number') {
              totalPages = res.numPages
            }
            const txs = Array.isArray(res?.txs) ? res.txs : []
            if (txs.length === 0) {
              break
            }

            for (const tx of txs) {
              const outputs = Array.isArray(tx?.outputs) ? tx.outputs : []
              for (const out of outputs) {
                const script = out?.outputScript
                if (typeof script === 'string') {
                  const alias = extractAliasFromOutputScript(script, address)
                  if (alias) return alias
                }
              }
            }

            if (typeof res?.numPages !== 'number' && txs.length < pageSize) {
              break
            }

            page += 1
          }
        } catch {
          // ignore chronik history errors
        }
      }
    }
  } catch {
    // continue
  }

  // 3. Fallback: query alias service API
  try {
    const cleanAddr = address.trim()
    const endpoints = [
      `https://alias.ecash.mx/alias/address/${encodeURIComponent(cleanAddr)}`,
      `https://alias.ecash.mx/address/${encodeURIComponent(cleanAddr)}`,
      `https://alias.ecash.mx/alias?address=${encodeURIComponent(cleanAddr)}`
    ]
    for (const url of endpoints) {
      try {
        const res = await fetch(url, { headers: { Accept: 'application/json' } })
        if (res.ok) {
          const data = await res.json()
          if (data && typeof data === 'object') {
            const candidate = (data as any).alias ?? (data as any).name
            if (typeof candidate === 'string' && candidate.length > 0) {
              return candidate.endsWith('.xec') ? candidate : `${candidate}.xec`
            }
          }
        }
      } catch {
        // try next endpoint
      }
    }
  } catch {
    // ignore
  }

  return null
}
