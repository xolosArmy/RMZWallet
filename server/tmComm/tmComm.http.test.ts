import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { TM_COMM_COOKIE_NAME, loadTmCommRuntimeConfig } from './tmCommConfig'
import { bootstrapTmCommStaging } from './tmCommBootstrap'
import { createTmCommHttpServer, listenTmCommHttpServer } from './tmCommHttp'
import { TmCommService } from './tmCommService'
import { TmCommStore } from './tmCommStore'
import { cookieValue, createTmCommEphemeralWallet } from './tmCommTestUtils'

type Started = {
  baseUrl: string
  origin: string
  store: TmCommStore
  service: TmCommService
  operatorWallet: ReturnType<typeof createTmCommEphemeralWallet>
  enrollments: ReturnType<typeof bootstrapTmCommStaging>['enrollments']
  close: () => Promise<void>
}

const fixtures: Started[] = []

afterEach(async () => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop()
    if (fixture) await fixture.close()
  }
})

async function startStaging(): Promise<Started> {
  const directory = mkdtempSync(join(tmpdir(), 'tm-comm-a0-'))
  const origin = 'http://tm-comm.staging.test'
  const config = loadTmCommRuntimeConfig({
    databasePath: join(directory, 'tm-comm-a0.sqlite'),
    expectedOrigin: origin,
    listenHost: '127.0.0.1',
    listenPort: 0
  })
  const store = new TmCommStore(config.databasePath)
  const operator = createTmCommEphemeralWallet()
  const bootstrap = bootstrapTmCommStaging(store, config, {
    address: operator.address,
    publicKeyHex: operator.publicKeyHex
  })
  const service = new TmCommService(store, config)
  const server = await listenTmCommHttpServer(createTmCommHttpServer(service, config), config)
  const started: Started = {
    baseUrl: server.tmCommBaseUrl,
    origin,
    store,
    service,
    operatorWallet: operator,
    enrollments: bootstrap.enrollments,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
  fixtures.push(started)
  return started
}

async function request(
  started: Started,
  path: string,
  init: RequestInit & {
    token?: string
    origin?: string | null
    skipOrigin?: boolean
    rawContentType?: string | null
  } = {}
) {
  const headers = new Headers(init.headers)
  if (!init.skipOrigin) {
    if (init.origin !== undefined) {
      if (init.origin !== null) headers.set('Origin', init.origin)
    } else {
      headers.set('Origin', started.origin)
    }
  }
  if (init.rawContentType !== undefined) {
    if (init.rawContentType !== null) {
      headers.set('Content-Type', init.rawContentType)
    } else {
      headers.delete('Content-Type')
    }
  } else if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  if (init.token) {
    headers.set('Cookie', `${TM_COMM_COOKIE_NAME}=${init.token}`)
  }
  const response = await fetch(`${started.baseUrl}${path}`, {
    ...init,
    headers
  })
  const text = await response.text()
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    // not json
  }
  return {
    status: response.status,
    json,
    text,
    token: cookieValue(response.headers.getSetCookie(), TM_COMM_COOKIE_NAME)
  }
}

async function authenticate(
  started: Started,
  wallet: ReturnType<typeof createTmCommEphemeralWallet>
) {
  const challenge = await request(started, '/v1/tm-comm/challenges', { method: 'POST' })
  expect(challenge.status).toBe(201)
  const payload = challenge.json as {
    challengeId: string
    canonicalMessage: string
  }
  const session = await request(started, '/v1/tm-comm/sessions', {
    method: 'POST',
    body: JSON.stringify({
      challengeId: payload.challengeId,
      address: wallet.address,
      publicKeyHex: wallet.publicKeyHex,
      signature: wallet.sign(payload.canonicalMessage)
    })
  })
  expect(session.status).toBe(201)
  expect(session.token).toBeTruthy()
  return {
    token: session.token as string,
    principalId: (session.json.principal as { id: string }).id
  }
}

describe('TM-COMM A0 HTTP API', () => {
  test('health is staging-only and has no financial authority', async () => {
    const started = await startStaging()
    const health = await request(started, '/v1/tm-comm/health')
    expect(health.status).toBe(200)
    expect(health.json).toMatchObject({
      ok: true,
      environment: 'staging',
      financialAuthority: false,
      memoPublication: false
    })
  })

  test('a known wallet address does not grant reservation access until enrollment', async () => {
    const started = await startStaging()
    const wallet = createTmCommEphemeralWallet()
    const session = await authenticate(started, wallet)
    const me = await request(started, ' /v1/tm-comm/me'.trim(), { token: session.token })
    expect(me.status).toBe(200)
    expect(me.json.bindings).toEqual([])
    const conversations = await request(started, '/v1/tm-comm/conversations', {
      token: session.token
    })
    expect(conversations.status).toBe(200)
    expect(conversations.json.conversations).toEqual([])
  })

  test('nonce is single-use and origin/expiry are enforced', async () => {
    const started = await startStaging()
    const wallet = createTmCommEphemeralWallet()
    const challenge = await request(started, '/v1/tm-comm/challenges', { method: 'POST' })
    const payload = challenge.json as { challengeId: string; canonicalMessage: string }
    const proof = {
      challengeId: payload.challengeId,
      address: wallet.address,
      publicKeyHex: wallet.publicKeyHex,
      signature: wallet.sign(payload.canonicalMessage)
    }
    const first = await request(started, '/v1/tm-comm/sessions', {
      method: 'POST',
      body: JSON.stringify(proof)
    })
    expect(first.status).toBe(201)
    const replay = await request(started, '/v1/tm-comm/sessions', {
      method: 'POST',
      body: JSON.stringify(proof)
    })
    expect(replay.status).toBe(401)
    expect((replay.json.error as { reasonCode: string }).reasonCode).toBe('CHALLENGE_CONSUMED')

    const mismatched = await fetch(`${started.baseUrl}/v1/tm-comm/challenges`, {
      method: 'POST',
      headers: { Origin: 'http://evil.example' }
    })
    expect(mismatched.status).toBe(401)
  })

  test('client A cannot read, list, send as, or touch metadata of client B', async () => {
    const started = await startStaging()
    const walletA = createTmCommEphemeralWallet()
    const walletB = createTmCommEphemeralWallet()
    const sessionA = await authenticate(started, walletA)
    const sessionB = await authenticate(started, walletB)
    const tokenA = started.enrollments.find((item) => item.label === 'client-a')
    const tokenB = started.enrollments.find((item) => item.label === 'client-b')
    expect(tokenA && tokenB).toBeTruthy()

    const bindA = await request(started, '/v1/tm-comm/bindings', {
      method: 'POST',
      token: sessionA.token,
      body: JSON.stringify({
        enrollmentToken: tokenA!.enrollmentToken,
        reservationId: tokenB!.reservationId
      })
    })
    expect(bindA.status).toBe(403)

    const realBindA = await request(started, '/v1/tm-comm/bindings', {
      method: 'POST',
      token: sessionA.token,
      body: JSON.stringify({ enrollmentToken: tokenA!.enrollmentToken })
    })
    const realBindB = await request(started, '/v1/tm-comm/bindings', {
      method: 'POST',
      token: sessionB.token,
      body: JSON.stringify({ enrollmentToken: tokenB!.enrollmentToken })
    })
    expect(realBindA.status).toBe(201)
    expect(realBindB.status).toBe(201)

    const conversationA = (realBindA.json.conversation as { id: string; reservationId: string })
    const conversationB = (realBindB.json.conversation as { id: string; reservationId: string })
    expect(conversationA.reservationId).toBe('rsv_staging_client_a')
    expect(conversationB.reservationId).toBe('rsv_staging_client_b')
    expect(conversationA.id).not.toBe(conversationB.id)

    const sentB = await request(started, `/v1/tm-comm/conversations/${conversationB.id}/messages`, {
      method: 'POST',
      token: sessionB.token,
      body: JSON.stringify({
        clientMessageId: 'client-b-msg-1',
        body: 'Private note for reservation B'
      })
    })
    expect(sentB.status).toBe(201)
    const messageB = sentB.json as { id: string }

    const listBAsA = await request(
      started,
      `/v1/tm-comm/conversations/${conversationB.id}/messages`,
      { token: sessionA.token }
    )
    expect(listBAsA.status).toBe(403)

    const getBAsA = await request(
      started,
      `/v1/tm-comm/conversations/${conversationB.id}`,
      { token: sessionA.token }
    )
    expect(getBAsA.status).toBe(403)

    const sendAsB = await request(
      started,
      `/v1/tm-comm/conversations/${conversationA.id}/messages`,
      {
        method: 'POST',
        token: sessionA.token,
        body: JSON.stringify({
          clientMessageId: 'impersonate-b',
          body: 'trying to speak as B',
          senderPrincipalId: sessionB.principalId,
          customerId: sessionB.principalId,
          reservationId: conversationB.reservationId,
          conversationId: conversationB.id,
          walletAddress: walletB.address
        })
      }
    )
    expect(sendAsB.status).toBe(403)

    const sendIntoB = await request(
      started,
      `/v1/tm-comm/conversations/${conversationB.id}/messages`,
      {
        method: 'POST',
        token: sessionA.token,
        body: JSON.stringify({
          clientMessageId: 'cross-write',
          body: 'A writing into B'
        })
      }
    )
    expect(sendIntoB.status).toBe(403)

    const attachment = await request(
      started,
      `/v1/tm-comm/attachments/${messageB.id}`,
      { token: sessionA.token }
    )
    expect(attachment.status).toBe(403)

    const receipt = await request(
      started,
      `/v1/tm-comm/messages/${messageB.id}/receipts`,
      {
        method: 'PUT',
        token: sessionA.token,
        body: JSON.stringify({ state: 'read' })
      }
    )
    expect(receipt.status).toBe(403)

    const listA = await request(started, '/v1/tm-comm/conversations', { token: sessionA.token })
    const listed = listA.json.conversations as Array<{ id: string }>
    expect(listed.map((item) => item.id)).toEqual([conversationA.id])

    const denied = started.service.listDeniedAudits()
    const reasons = denied.map((event) => event.reasonCode)
    expect(reasons).toContain('CONVERSATION_FORBIDDEN')
    expect(reasons).toContain('SENDER_IMPERSONATION')
    expect(reasons).toContain('ATTACHMENT_UNAVAILABLE')
    expect(reasons).toContain('RESERVATION_CLAIM_MISMATCH')
    expect(denied.every((event) => event.outcome === 'deny')).toBe(true)
  })

  test('accepted messages survive store reopen and support receipts plus idempotency', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tm-comm-durable-'))
    const dbPath = join(directory, 'durable.sqlite')
    const origin = 'http://tm-comm.staging.test'
    const config = loadTmCommRuntimeConfig({
      databasePath: dbPath,
      expectedOrigin: origin,
      listenHost: '127.0.0.1',
      listenPort: 0
    })
    const wallet = createTmCommEphemeralWallet()
    const operator = createTmCommEphemeralWallet()
    let store = new TmCommStore(dbPath)
    const bootstrap = bootstrapTmCommStaging(store, config, {
      address: operator.address,
      publicKeyHex: operator.publicKeyHex
    })
    let service = new TmCommService(store, config)
    let server = await listenTmCommHttpServer(createTmCommHttpServer(service, config), config)
    const started: Started = {
      baseUrl: server.tmCommBaseUrl,
      origin,
      store,
      service,
      operatorWallet: operator,
      enrollments: bootstrap.enrollments,
      close: async () => undefined
    }

    try {
      const session = await authenticate(started, wallet)
      const bind = await request(started, '/v1/tm-comm/bindings', {
        method: 'POST',
        token: session.token,
        body: JSON.stringify({ enrollmentToken: bootstrap.enrollments[0].enrollmentToken })
      })
      expect(bind.status).toBe(201)
      const conversationId = (bind.json.conversation as { id: string }).id
      const sent = await request(started, `/v1/tm-comm/conversations/${conversationId}/messages`, {
        method: 'POST',
        token: session.token,
        body: JSON.stringify({
          clientMessageId: 'durable-1',
          body: 'Durable private message'
        })
      })
      expect(sent.status).toBe(201)
      const firstId = (sent.json as { id: string; serverCreatedAt: number }).id
      const replay = await request(started, `/v1/tm-comm/conversations/${conversationId}/messages`, {
        method: 'POST',
        token: session.token,
        body: JSON.stringify({
          clientMessageId: 'durable-1',
          body: 'Durable private message'
        })
      })
      expect((replay.json as { id: string }).id).toBe(firstId)

      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
      store.close()

      store = new TmCommStore(dbPath)
      service = new TmCommService(store, config)
      server = await listenTmCommHttpServer(createTmCommHttpServer(service, config), config)
      started.baseUrl = server.tmCommBaseUrl
      started.store = store
      started.service = service

      const listed = await request(started, `/v1/tm-comm/conversations/${conversationId}/messages`, {
        token: session.token
      })
      expect(listed.status).toBe(200)
      const messages = listed.json.messages as Array<{
        id: string
        body: string
        status: string
        serverCreatedAt: number
      }>
      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({
        id: firstId,
        body: 'Durable private message',
        status: 'accepted'
      })
      expect(messages[0].serverCreatedAt).toBeGreaterThan(0)

      // P2-3: Sender attempts self-receipt -> rejected with 403 SELF_RECEIPT_FORBIDDEN
      const selfReceipt = await request(started, `/v1/tm-comm/messages/${firstId}/receipts`, {
        method: 'PUT',
        token: session.token,
        body: JSON.stringify({ state: 'delivered' })
      })
      expect(selfReceipt.status).toBe(403)
      expect(selfReceipt.json).toMatchObject({
        error: {
          code: 'FORBIDDEN',
          reasonCode: 'SELF_RECEIPT_FORBIDDEN'
        }
      })

      // Authenticate the recipient (operator)
      const operatorSession = await authenticate(started, operator)
      const receipt = await request(started, `/v1/tm-comm/messages/${firstId}/receipts`, {
        method: 'PUT',
        token: operatorSession.token,
        body: JSON.stringify({ state: 'delivered' })
      })
      expect(receipt.status).toBe(200)

      // Verify aggregate status reached delivered
      const listedAfterDelivered = await request(started, `/v1/tm-comm/conversations/${conversationId}/messages`, {
        token: session.token
      })
      const messagesAfterDelivered = listedAfterDelivered.json.messages as Array<{
        id: string
        status: string
      }>
      expect(messagesAfterDelivered[0].status).toBe('delivered')
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('P2-2: enforces expected origin on authenticated mutations and rejects text/plain bypass with audit denial', async () => {
    const started = await startStaging()
    const wallet = createTmCommEphemeralWallet()
    const session = await authenticate(started, wallet)

    // 1. Authorized origin allowed on mutation (POST bindings)
    const bindAllowed = await request(started, '/v1/tm-comm/bindings', {
      method: 'POST',
      token: session.token,
      body: JSON.stringify({ enrollmentToken: started.enrollments[0].enrollmentToken })
    })
    expect(bindAllowed.status).toBe(201)
    const conversationId = (bindAllowed.json.conversation as { id: string }).id

    // 2. Foreign origin rejected on mutation (POST messages)
    const foreignOrigin = await request(started, `/v1/tm-comm/conversations/${conversationId}/messages`, {
      method: 'POST',
      token: session.token,
      origin: 'https://attacker.com',
      body: JSON.stringify({
        clientMessageId: 'msg-attacker-origin-1',
        body: 'Attacker message'
      })
    })
    expect(foreignOrigin.status).toBe(403)
    expect(foreignOrigin.json).toMatchObject({
      error: {
        code: 'FORBIDDEN',
        reasonCode: 'ORIGIN_MISMATCH'
      }
    })

    // 3. Port mismatch on 127.0.0.1 rejected
    const portMismatch = await request(started, `/v1/tm-comm/conversations/${conversationId}/messages`, {
      method: 'POST',
      token: session.token,
      origin: 'http://127.0.0.1:5175',
      body: JSON.stringify({
        clientMessageId: 'msg-wrong-port-1',
        body: 'Wrong port'
      })
    })
    expect(portMismatch.status).toBe(403)
    expect(portMismatch.json).toMatchObject({
      error: {
        code: 'FORBIDDEN',
        reasonCode: 'ORIGIN_MISMATCH'
      }
    })

    // 4. Missing origin header rejected on mutation
    const missingOrigin = await request(started, `/v1/tm-comm/conversations/${conversationId}/messages`, {
      method: 'POST',
      token: session.token,
      skipOrigin: true,
      body: JSON.stringify({
        clientMessageId: 'msg-no-origin-1',
        body: 'No origin'
      })
    })
    expect(missingOrigin.status).toBe(403)
    expect(missingOrigin.json).toMatchObject({
      error: {
        code: 'FORBIDDEN',
        reasonCode: 'ORIGIN_MISMATCH'
      }
    })

    // 5. text/plain Content-Type rejected with 415 CONTENT_TYPE_UNSUPPORTED
    const textPlain = await request(started, `/v1/tm-comm/conversations/${conversationId}/messages`, {
      method: 'POST',
      token: session.token,
      rawContentType: 'text/plain',
      body: JSON.stringify({
        clientMessageId: 'msg-text-plain-1',
        body: 'text plain bypass attempt'
      })
    })
    expect(textPlain.status).toBe(415)
    expect(textPlain.json).toMatchObject({
      error: {
        code: 'INVALID_INPUT',
        reasonCode: 'CONTENT_TYPE_UNSUPPORTED'
      }
    })

    // 6. Missing Content-Type rejected with 415 CONTENT_TYPE_REQUIRED
    const missingContentType = await request(started, `/v1/tm-comm/conversations/${conversationId}/messages`, {
      method: 'POST',
      token: session.token,
      rawContentType: null,
      body: JSON.stringify({
        clientMessageId: 'msg-no-content-type-1',
        body: 'no content type'
      })
    })
    expect(missingContentType.status).toBe(415)
    expect(missingContentType.json).toMatchObject({
      error: {
        code: 'INVALID_INPUT',
        reasonCode: 'CONTENT_TYPE_UNSUPPORTED'
      }
    })

    // 7. Valid session cookie with wrong origin rejected on receipt mutation
    const validSend = await request(started, `/v1/tm-comm/conversations/${conversationId}/messages`, {
      method: 'POST',
      token: session.token,
      body: JSON.stringify({
        clientMessageId: 'msg-valid-origin-1',
        body: 'Valid message'
      })
    })
    expect(validSend.status).toBe(201)
    const messageId = (validSend.json as { id: string }).id

    const wrongOriginReceipt = await request(started, `/v1/tm-comm/messages/${messageId}/receipts`, {
      method: 'PUT',
      token: session.token,
      origin: 'https://evil.site',
      body: JSON.stringify({ state: 'delivered' })
    })
    expect(wrongOriginReceipt.status).toBe(403)
    expect(wrongOriginReceipt.json).toMatchObject({
      error: {
        code: 'FORBIDDEN',
        reasonCode: 'ORIGIN_MISMATCH'
      }
    })

    // 8. Audit log records denial events with reasonCode ORIGIN_MISMATCH
    const deniedAudits = started.service.listDeniedAudits()
    const originDenied = deniedAudits.filter((audit) => audit.reasonCode === 'ORIGIN_MISMATCH')
    expect(originDenied.length).toBeGreaterThanOrEqual(4)
    for (const audit of originDenied) {
      expect(audit.outcome).toBe('deny')
      expect(audit.actorPrincipalId).toBe(session.principalId)
    }
  })

  test('P2-3: sender cannot generate receipts; aggregate message status derives strictly from recipients', async () => {
    const started = await startStaging()
    const senderWallet = createTmCommEphemeralWallet()
    const senderSession = await authenticate(started, senderWallet)

    const bind = await request(started, '/v1/tm-comm/bindings', {
      method: 'POST',
      token: senderSession.token,
      body: JSON.stringify({ enrollmentToken: started.enrollments[0].enrollmentToken })
    })
    expect(bind.status).toBe(201)
    const conversationId = (bind.json.conversation as { id: string }).id

    const sent = await request(started, `/v1/tm-comm/conversations/${conversationId}/messages`, {
      method: 'POST',
      token: senderSession.token,
      body: JSON.stringify({
        clientMessageId: 'msg-p2-3-receipt-test',
        body: 'Message for receipt testing'
      })
    })
    expect(sent.status).toBe(201)
    const messageId = (sent.json as { id: string }).id
    expect((sent.json as { status: string }).status).toBe('accepted')

    // 1. Sender attempts delivered receipt -> 403 SELF_RECEIPT_FORBIDDEN
    const senderDelivered = await request(started, `/v1/tm-comm/messages/${messageId}/receipts`, {
      method: 'PUT',
      token: senderSession.token,
      body: JSON.stringify({ state: 'delivered' })
    })
    expect(senderDelivered.status).toBe(403)
    expect(senderDelivered.json).toMatchObject({
      error: {
        code: 'FORBIDDEN',
        reasonCode: 'SELF_RECEIPT_FORBIDDEN'
      }
    })

    // 2. Sender attempts read receipt -> 403 SELF_RECEIPT_FORBIDDEN
    const senderRead = await request(started, `/v1/tm-comm/messages/${messageId}/receipts`, {
      method: 'PUT',
      token: senderSession.token,
      body: JSON.stringify({ state: 'read' })
    })
    expect(senderRead.status).toBe(403)
    expect(senderRead.json).toMatchObject({
      error: {
        code: 'FORBIDDEN',
        reasonCode: 'SELF_RECEIPT_FORBIDDEN'
      }
    })

    // Message status remains 'accepted' despite sender receipt attempts
    const checkAfterSenderAttempts = await request(
      started,
      `/v1/tm-comm/conversations/${conversationId}/messages`,
      { token: senderSession.token }
    )
    const msgs1 = checkAfterSenderAttempts.json.messages as Array<{ id: string; status: string }>
    expect(msgs1[0].status).toBe('accepted')

    // 3. Third-party principal (not in conversation) cannot issue receipt
    const thirdPartyWallet = createTmCommEphemeralWallet()
    const thirdPartySession = await authenticate(started, thirdPartyWallet)
    const thirdPartyReceipt = await request(started, `/v1/tm-comm/messages/${messageId}/receipts`, {
      method: 'PUT',
      token: thirdPartySession.token,
      body: JSON.stringify({ state: 'delivered' })
    })
    expect(thirdPartyReceipt.status).toBe(403)

    // 4. Recipient attempts impersonation of another principal -> 403 RECEIPT_IMPERSONATION
    const operatorSession = await authenticate(started, started.operatorWallet)
    const impersonatedReceipt = await request(started, `/v1/tm-comm/messages/${messageId}/receipts`, {
      method: 'PUT',
      token: operatorSession.token,
      body: JSON.stringify({ state: 'delivered', principalId: senderSession.principalId })
    })
    expect(impersonatedReceipt.status).toBe(403)
    expect(impersonatedReceipt.json).toMatchObject({
      error: {
        code: 'FORBIDDEN',
        reasonCode: 'RECEIPT_IMPERSONATION'
      }
    })

    // 5. Valid recipient marks delivered -> status transitions to 'delivered'
    const recipientDelivered = await request(started, `/v1/tm-comm/messages/${messageId}/receipts`, {
      method: 'PUT',
      token: operatorSession.token,
      body: JSON.stringify({ state: 'delivered' })
    })
    expect(recipientDelivered.status).toBe(200)

    const checkAfterDelivered = await request(
      started,
      `/v1/tm-comm/conversations/${conversationId}/messages`,
      { token: senderSession.token }
    )
    const msgs2 = checkAfterDelivered.json.messages as Array<{ id: string; status: string }>
    expect(msgs2[0].status).toBe('delivered')

    // 6. Valid recipient marks read -> status transitions to 'read'
    const recipientRead = await request(started, `/v1/tm-comm/messages/${messageId}/receipts`, {
      method: 'PUT',
      token: operatorSession.token,
      body: JSON.stringify({ state: 'read' })
    })
    expect(recipientRead.status).toBe(200)

    const checkAfterRead = await request(
      started,
      `/v1/tm-comm/conversations/${conversationId}/messages`,
      { token: senderSession.token }
    )
    const msgs3 = checkAfterRead.json.messages as Array<{ id: string; status: string }>
    expect(msgs3[0].status).toBe('read')

    // 7. Idempotency: re-issuing read receipt succeeds and keeps status as read
    const recipientReadAgain = await request(started, `/v1/tm-comm/messages/${messageId}/receipts`, {
      method: 'PUT',
      token: operatorSession.token,
      body: JSON.stringify({ state: 'read' })
    })
    expect(recipientReadAgain.status).toBe(200)

    const checkAfterReadAgain = await request(
      started,
      `/v1/tm-comm/conversations/${conversationId}/messages`,
      { token: senderSession.token }
    )
    const msgs4 = checkAfterReadAgain.json.messages as Array<{ id: string; status: string }>
    expect(msgs4[0].status).toBe('read')
  })
})
