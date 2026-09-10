export const FALLBACK_PUBLIC_IPFS_GATEWAYS: readonly string[] = [
  'https://tomato-rational-rat-921.mypinata.cloud/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
  'https://dweb.link/ipfs/',
  'https://w3s.link/ipfs/',
  'https://ipfs.io/ipfs/',
  'https://cloudflare-ipfs.com/ipfs/'
]

const normalizeGatewayBase = (value?: string): string => {
  const trimmed = value?.trim() || ''
  if (!trimmed) return ''
  if (/^ipfs:\/\//i.test(trimmed)) return ''
  let base = trimmed
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(base)) {
    base = `https://${base}`
  }
  if (!base.endsWith('/')) {
    base += '/'
  }
  if (/\/ipfs\/$/i.test(base)) return base
  if (/\/ipfs$/i.test(base)) return `${base}/`
  return `${base}ipfs/`
}

export const resolveIpfsGatewayBases = (customGateway?: string): string[] => {
  const candidates: string[] = []
  if (customGateway) {
    const normalized = normalizeGatewayBase(customGateway)
    if (normalized) candidates.push(normalized)
  }
  const envPrimary =
    import.meta.env.VITE_IPFS_GATEWAY_BASE ||
    import.meta.env.VITE_IPFS_GATEWAY ||
    import.meta.env.VITE_PINATA_GATEWAY
  if (envPrimary) {
    const normalized = normalizeGatewayBase(envPrimary)
    if (normalized) candidates.push(normalized)
  }
  const envFallback = import.meta.env.VITE_IPFS_GATEWAY_FALLBACK
  if (envFallback) {
    const normalized = normalizeGatewayBase(envFallback)
    if (normalized) candidates.push(normalized)
  }
  for (const gw of FALLBACK_PUBLIC_IPFS_GATEWAYS) {
    const normalized = normalizeGatewayBase(gw)
    if (normalized) candidates.push(normalized)
  }
  return Array.from(new Set(candidates))
}

const resolveGatewayBase = (gatewayBase?: string): string => {
  const bases = resolveIpfsGatewayBases(gatewayBase)
  return bases[0] || 'https://tomato-rational-rat-921.mypinata.cloud/ipfs/'
}

export const DEFAULT_IPFS_GATEWAY_BASE = resolveGatewayBase()

const splitCidPath = (value: string): { cid: string; path: string } | null => {
  const trimmed = value.trim()
  if (!trimmed) return null
  const [cid, ...rest] = trimmed.split('/')
  if (!cid) return null
  const path = rest.length > 0 ? `/${rest.join('/')}` : ''
  return { cid, path }
}

const parseIpfsParts = (value: string): { cid: string; path: string } | null => {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (/^ipfs:\/\//i.test(trimmed)) {
    let remainder = trimmed.replace(/^ipfs:\/\//i, '')
    if (remainder.toLowerCase().startsWith('ipfs/')) {
      remainder = remainder.slice(5)
    }
    return splitCidPath(remainder)
  }
  if (/^https?:\/\//i.test(trimmed)) {
    const match = trimmed.match(/\/ipfs\/([^?#]+)/i)
    return match ? splitCidPath(match[1]) : null
  }
  if (/^ipfs\//i.test(trimmed)) {
    const remainder = trimmed.replace(/^ipfs\//i, '')
    return splitCidPath(remainder)
  }
  return splitCidPath(trimmed)
}

export const ipfsToCid = (url: string): string | null => {
  const parts = parseIpfsParts(url)
  return parts ? parts.cid : null
}

export const getIpfsGatewayUrls = (url: string, customGateway?: string): string[] => {
  if (!url) return []
  const trimmed = url.trim()
  const parts = parseIpfsParts(trimmed)
  if (!parts) {
    if (/^https?:\/\//i.test(trimmed)) {
      return [trimmed]
    }
    return []
  }
  const bases = resolveIpfsGatewayBases(customGateway)
  const urls = bases.map((base) => `${base}${parts.cid}${parts.path}`)
  return Array.from(new Set(urls))
}

export const ipfsToGatewayUrl = (url: string, gatewayBase?: string): string | null => {
  const urls = getIpfsGatewayUrls(url, gatewayBase)
  return urls.length > 0 ? urls[0] : null
}

export interface FetchIpfsJsonOptions {
  timeoutMs?: number
  signal?: AbortSignal
  customGateways?: string[]
}

export interface FetchIpfsJsonResult<T = Record<string, unknown>> {
  data: T
  url: string
  gateway: string
}

export const fetchIpfsJson = async <T = Record<string, unknown>>(
  uri: string,
  options: FetchIpfsJsonOptions = {}
): Promise<FetchIpfsJsonResult<T> | null> => {
  if (!uri || typeof uri !== 'string') return null
  const { timeoutMs = 4500, signal: parentSignal, customGateways } = options

  if (parentSignal?.aborted) {
    return null
  }

  const candidateUrls = customGateways && customGateways.length > 0
    ? Array.from(new Set(customGateways.flatMap((gw) => getIpfsGatewayUrls(uri, gw))))
    : getIpfsGatewayUrls(uri)

  if (candidateUrls.length === 0) {
    return null
  }

  for (const url of candidateUrls) {
    if (parentSignal?.aborted) {
      return null
    }

    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, timeoutMs)

    const onParentAbort = () => {
      controller.abort()
    }

    if (parentSignal) {
      parentSignal.addEventListener('abort', onParentAbort, { once: true })
    }

    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          Accept: 'application/json, text/plain, */*'
        }
      })

      if (!response.ok) {
        continue
      }

      const text = await response.text()
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        continue
      }

      if (json && typeof json === 'object') {
        const gwBase = resolveIpfsGatewayBases().find((b) => url.startsWith(b)) || url
        return {
          data: json as T,
          url,
          gateway: gwBase
        }
      }
    } catch {
      continue
    } finally {
      clearTimeout(timer)
      if (parentSignal) {
        parentSignal.removeEventListener('abort', onParentAbort)
      }
    }
  }

  return null
}

export const getIpfsAssetUrl = (cid: string, gatewayBase: string): string => {
  if (import.meta.env.DEV) {
    return `/ipfs/${cid}`
  }
  return `${gatewayBase}${cid}`
}

export const resolveIpfsGatewayBase = (gatewayBase?: string): string => resolveGatewayBase(gatewayBase)
