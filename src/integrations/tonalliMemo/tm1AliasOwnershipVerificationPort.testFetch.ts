/**
 * Test-only alias.ecash.mx fetch double and test factory.
 * Not a production observer, not a caller-supplied observe() lambda,
 * and not a public fetch/endpointUrl mint path.
 * App / routes / RegisterAlias / orchestrator must not import this file.
 */

import {
  createTm1AliasOwnershipVerificationPort,
  type Tm1AliasOwnershipVerificationPort
} from './tm1AliasOwnershipVerificationPort'
import { Tm1AliasPublicationAuthorizationError } from './tm1AliasPublicationAuthorizationError'

const TEST_SEAM = 'tonalli.tm1AliasOwnershipVerificationPort.createForTests'

export function createTm1AliasOwnershipVerificationPortForTests(
  deps: unknown
): Tm1AliasOwnershipVerificationPort {
  const create = (
    createTm1AliasOwnershipVerificationPort as typeof createTm1AliasOwnershipVerificationPort & {
      [TEST_SEAM]?: (value: unknown) => Tm1AliasOwnershipVerificationPort
    }
  )[TEST_SEAM]
  if (typeof create !== 'function') {
    throw new Tm1AliasPublicationAuthorizationError('INVALID_ALIAS_AUTHORIZATION_INPUT')
  }
  return create(deps)
}

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
