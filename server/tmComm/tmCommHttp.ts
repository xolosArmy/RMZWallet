import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http'
import { TM_COMM_ERROR_CODES, TmCommError } from '../../src/features/privateMessaging/errors'
import type { TmCommReceiptState } from '../../src/features/privateMessaging/types'
import {
  TM_COMM_MAX_BODY_BYTES,
  type TmCommRuntimeConfig
} from './tmCommConfig'
import { TmCommService } from './tmCommService'

const jsonHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store, max-age=0',
  'X-Content-Type-Options': 'nosniff'
}

export type TmCommHttpServer = Server & {
  readonly tmCommBaseUrl: string
}

export function createTmCommHttpServer(
  service: TmCommService,
  config: TmCommRuntimeConfig
): Server {
  return createServer((request, response) => {
    void handleRequest(service, config, request, response)
  })
}

export async function listenTmCommHttpServer(
  server: Server,
  config: TmCommRuntimeConfig
): Promise<TmCommHttpServer> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.listenPort, config.listenHost, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('TM-COMM server failed to bind a TCP port.')
  }
  const decorated = server as TmCommHttpServer
  Object.defineProperty(decorated, 'tmCommBaseUrl', {
    value: `http://${config.listenHost}:${address.port}`,
    writable: false
  })
  return decorated
}

async function handleRequest(
  service: TmCommService,
  config: TmCommRuntimeConfig,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
    const origin = readOrigin(request)
    const method = request.method ?? 'GET'

    if (method === 'GET' && url.pathname === '/v1/tm-comm/health') {
      writeJson(response, 200, {
        ok: true,
        environment: config.environment,
        protocol: 'tm-comm',
        version: 1,
        financialAuthority: false,
        memoPublication: false
      })
      return
    }

    if (method === 'POST' && url.pathname === '/v1/tm-comm/challenges') {
      const challenge = service.createChallenge(origin)
      writeJson(response, 201, challenge)
      return
    }

    if (method === 'POST' && url.pathname === '/v1/tm-comm/sessions') {
      const body = await readJson(request)
      const session = service.createSession({
        challengeId: readString(body, 'challengeId'),
        address: readString(body, 'address'),
        publicKeyHex: readString(body, 'publicKeyHex'),
        signature: readString(body, 'signature'),
        requestOrigin: origin
      })
      response.setHeader('Set-Cookie', serializeCookie(config, session.token, session.expiresAt))
      writeJson(response, 201, {
        principal: {
          id: session.principal.id,
          kind: session.principal.kind,
          walletAddress: session.principal.walletAddress
        },
        expiresAt: session.expiresAt
      })
      return
    }

    const principal = service.authenticate(readCookie(request, config.cookieName))

    if (method === 'GET' && url.pathname === '/v1/tm-comm/me') {
      writeJson(response, 200, service.getMe(principal))
      return
    }

    if (method === 'POST' && url.pathname === '/v1/tm-comm/bindings') {
      const body = await readJson(request)
      const result = service.bindReservation(
        principal,
        readString(body, 'enrollmentToken'),
        optionalString(body, 'reservationId')
      )
      writeJson(response, 201, result)
      return
    }

    if (method === 'GET' && url.pathname === '/v1/tm-comm/conversations') {
      writeJson(response, 200, { conversations: service.listConversations(principal) })
      return
    }

    const conversationMatch = /^\/v1\/tm-comm\/conversations\/([^/]+)$/.exec(url.pathname)
    if (method === 'GET' && conversationMatch) {
      writeJson(response, 200, service.getConversation(principal, decodeURIComponent(conversationMatch[1])))
      return
    }

    const conversationMessagesMatch = /^\/v1\/tm-comm\/conversations\/([^/]+)\/messages$/.exec(url.pathname)
    if (conversationMessagesMatch) {
      const conversationId = decodeURIComponent(conversationMessagesMatch[1])
      if (method === 'GET') {
        writeJson(response, 200, {
          conversationId,
          messages: service.listMessages(principal, conversationId)
        })
        return
      }
      if (method === 'POST') {
        const body = await readJson(request)
        const message = service.sendMessage(principal, conversationId, {
          clientMessageId: readString(body, 'clientMessageId'),
          body: readString(body, 'body'),
          replyToId: optionalString(body, 'replyToId'),
          claimedSenderPrincipalId: optionalString(body, 'senderPrincipalId'),
          claimedConversationId: optionalString(body, 'conversationId'),
          claimedReservationId: optionalString(body, 'reservationId'),
          claimedCustomerId: optionalString(body, 'customerId'),
          claimedWalletAddress: optionalString(body, 'walletAddress')
        })
        writeJson(response, 201, message)
        return
      }
    }

    const receiptMatch = /^\/v1\/tm-comm\/messages\/([^/]+)\/receipts$/.exec(url.pathname)
    if (receiptMatch) {
      const messageId = decodeURIComponent(receiptMatch[1])
      if (method === 'GET') {
        writeJson(response, 200, {
          messageId,
          receipts: service.listReceipts(principal, messageId)
        })
        return
      }
      if (method === 'PUT') {
        const body = await readJson(request)
        const state = readString(body, 'state')
        if (state !== 'delivered' && state !== 'read') {
          throw new TmCommError(
            TM_COMM_ERROR_CODES.INVALID_INPUT,
            400,
            'Receipt state is invalid.',
            'RECEIPT_STATE_INVALID'
          )
        }
        writeJson(response, 200, service.upsertReceipt(principal, messageId, state as TmCommReceiptState))
        return
      }
    }

    const attachmentMatch = /^\/v1\/tm-comm\/(?:attachments|conversations\/[^/]+\/attachments)\/([^/]+)$/.exec(
      url.pathname
    )
    if (attachmentMatch && (method === 'GET' || method === 'HEAD')) {
      service.denyAttachment(principal, decodeURIComponent(attachmentMatch[1]))
    }

    writeJson(response, 404, {
      error: {
        code: 'NOT_FOUND',
        reasonCode: 'ROUTE_NOT_FOUND',
        message: 'Unknown TM-COMM route.'
      }
    })
  } catch (error) {
    if (error instanceof TmCommError) {
      writeJson(response, error.status, {
        error: {
          code: error.code,
          reasonCode: error.reasonCode,
          message: error.message
        }
      })
      return
    }
    writeJson(response, 500, {
      error: {
        code: 'INTERNAL',
        reasonCode: 'INTERNAL',
        message: 'TM-COMM request failed closed.'
      }
    })
  }
}

function readOrigin(request: IncomingMessage): string | null {
  const origin = request.headers.origin
  if (typeof origin === 'string' && origin.length > 0) return origin
  return null
}

function readCookie(request: IncomingMessage, name: string): string | null {
  const header = request.headers.cookie
  if (typeof header !== 'string') return null
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return null
}

function serializeCookie(
  config: TmCommRuntimeConfig,
  token: string,
  expiresAt: number
): string {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
  const parts = [
    `${config.cookieName}=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Strict',
    `Max-Age=${maxAge}`
  ]
  if (config.cookieSecure) parts.push('Secure')
  return parts.join('; ')
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    ...jsonHeaders,
    'Content-Length': Buffer.byteLength(payload)
  })
  response.end(payload)
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > TM_COMM_MAX_BODY_BYTES) {
      throw new TmCommError(
        TM_COMM_ERROR_CODES.INVALID_INPUT,
        413,
        'Request body is too large.',
        'BODY_TOO_LARGE'
      )
    }
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not object')
    }
    return parsed as Record<string, unknown>
  } catch {
    throw new TmCommError(
      TM_COMM_ERROR_CODES.INVALID_INPUT,
      400,
      'JSON body is invalid.',
      'JSON_INVALID'
    )
  }
}

function readString(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TmCommError(
      TM_COMM_ERROR_CODES.INVALID_INPUT,
      400,
      `${key} is required.`,
      'FIELD_REQUIRED'
    )
  }
  return value
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new TmCommError(
      TM_COMM_ERROR_CODES.INVALID_INPUT,
      400,
      `${key} must be a string.`,
      'FIELD_INVALID'
    )
  }
  return value
}
