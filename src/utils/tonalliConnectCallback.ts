const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function isAllowedProtocol(url: URL, allowInsecureLoopback: boolean): boolean {
  if (url.protocol === 'https:') return true
  return allowInsecureLoopback && url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)
}

export function parseTonalliConnectCallback(
  returnUrl: string,
  expectedOrigin: string,
  allowInsecureLoopback = false
): URL {
  const url = new URL(returnUrl)
  const originUrl = new URL(expectedOrigin)

  if (url.origin === 'null' || originUrl.origin === 'null') {
    throw new Error('OPAQUE_ORIGIN')
  }
  if (url.username || url.password || originUrl.username || originUrl.password) {
    throw new Error('CREDENTIALS_NOT_ALLOWED')
  }
  if (!isAllowedProtocol(url, allowInsecureLoopback) || !isAllowedProtocol(originUrl, allowInsecureLoopback)) {
    throw new Error('UNSAFE_CALLBACK_PROTOCOL')
  }
  if (originUrl.pathname !== '/' || originUrl.search || originUrl.hash) {
    throw new Error('INVALID_EXPECTED_ORIGIN')
  }
  if (url.origin !== originUrl.origin) {
    throw new Error('CALLBACK_ORIGIN_MISMATCH')
  }

  return url
}
