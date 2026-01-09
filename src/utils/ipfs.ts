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

const DEFAULT_IPFS_GATEWAY_BASE =
  normalizeGatewayBase(import.meta.env.VITE_IPFS_GATEWAY_FALLBACK) || 'https://ipfs.io/ipfs/'

const resolveGatewayBase = (gatewayBase?: string): string => {
  const envBase =
    gatewayBase || import.meta.env.VITE_IPFS_GATEWAY_BASE || import.meta.env.VITE_IPFS_GATEWAY || ''
  return normalizeGatewayBase(envBase) || DEFAULT_IPFS_GATEWAY_BASE
}

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

export const ipfsToGatewayUrl = (url: string, gatewayBase?: string): string | null => {
  const parts = parseIpfsParts(url)
  if (!parts) return null
  return `${resolveGatewayBase(gatewayBase)}${parts.cid}${parts.path}`
}

export const getIpfsAssetUrl = (cid: string, gatewayBase: string): string => {
  if (import.meta.env.DEV) {
    return `/ipfs/${cid}`
  }
  return `${gatewayBase}${cid}`
}

export const resolveIpfsGatewayBase = (gatewayBase?: string): string => resolveGatewayBase(gatewayBase)

export { DEFAULT_IPFS_GATEWAY_BASE }
