/**
 * Test-only alias.ecash.mx fetch double.
 * Not a production observer, not a caller-supplied observe() lambda,
 * and not a test constructor hung on the production class or factory.
 * App / routes / RegisterAlias / orchestrator must not import this file.
 */

export type Tm1AliasOwnershipTestFetchResponse = Readonly<{
  status: number
  json?: unknown
  text?: string
  throw?: Error
}>

export function createTm1AliasOwnershipVerificationTestFetch(
  byAlias: Readonly<Record<string, Tm1AliasOwnershipTestFetchResponse>>
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input)
    const alias = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) ?? '')
    const spec = byAlias[alias]
    if (spec === undefined) {
      return new Response('', { status: 404 })
    }
    if (spec.throw !== undefined) {
      throw spec.throw
    }
    if (init?.signal?.aborted) {
      const error = new Error('AbortError')
      error.name = 'AbortError'
      throw error
    }
    const body = spec.text !== undefined
      ? spec.text
      : spec.json === undefined
        ? ''
        : JSON.stringify(spec.json)
    return new Response(body, {
      status: spec.status,
      headers: { 'content-type': 'application/json' }
    })
  }) as typeof fetch
}

function requestUrl(input: RequestInfo | URL): URL {
  if (typeof input === 'string') return new URL(input)
  if (input instanceof URL) return input
  return new URL(input.url)
}
