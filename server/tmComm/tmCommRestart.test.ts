import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { TM_COMM_ERROR_CODES, TmCommError } from '../../src/features/privateMessaging/errors'
import { bootstrapTmCommStaging } from './tmCommBootstrap'
import { loadTmCommRuntimeConfig, TM_COMM_COOKIE_NAME } from './tmCommConfig'
import { createTmCommHttpServer, listenTmCommHttpServer } from './tmCommHttp'
import { TmCommService } from './tmCommService'
import { TmCommStore } from './tmCommStore'
import {
  cookieValue,
  createTmCommDeterministicWallet,
  createTmCommEphemeralWallet,
  resolveTmCommOperatorCredential
} from './tmCommTestUtils'

const { getFsMockState, setFsMockState, resetFsMock } = vi.hoisted(() => {
  type FsMockState = {
    targetDir: string
    errorCode: 'EACCES' | 'EPERM'
    operation: 'chmodSync' | 'mkdirSync'
    invoked: boolean
  }
  let state: FsMockState | null = null
  return {
    getFsMockState: () => state,
    setFsMockState: (s: FsMockState | null) => {
      state = s
    },
    resetFsMock: () => {
      state = null
    }
  }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    chmodSync: (path: import('node:fs').PathLike, mode: import('node:fs').Mode) => {
      const mock = getFsMockState()
      if (mock && mock.operation === 'chmodSync' && typeof path === 'string' && path === mock.targetDir) {
        mock.invoked = true
        const err = new Error(`${mock.errorCode}: permission denied, chmod '${path}'`) as NodeJS.ErrnoException
        err.code = mock.errorCode
        throw err
      }
      return actual.chmodSync(path, mode)
    },
    mkdirSync: (...args: Parameters<typeof actual.mkdirSync>) => {
      const [path] = args
      const mock = getFsMockState()
      if (mock && mock.operation === 'mkdirSync' && typeof path === 'string' && path === mock.targetDir) {
        mock.invoked = true
        const err = new Error(`${mock.errorCode}: permission denied, mkdir '${path}'`) as NodeJS.ErrnoException
        err.code = mock.errorCode
        throw err
      }
      return actual.mkdirSync(...args)
    }
  }
})

const tempDirectories: string[] = []

function makeTempDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tm-comm-restart-test-'))
  tempDirectories.push(dir)
  return dir
}

afterEach(() => {
  resetFsMock()
  for (const dir of tempDirectories) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup
    }
  }
  tempDirectories.length = 0
})

type TestServer = Readonly<{
  baseUrl: string
  origin: string
  store: TmCommStore
  service: TmCommService
  close: () => Promise<void>
}>

async function startServer(databasePath: string, origin = 'http://127.0.0.1:5174'): Promise<TestServer> {
  const config = loadTmCommRuntimeConfig({
    databasePath,
    expectedOrigin: origin,
    listenHost: '127.0.0.1',
    listenPort: 0
  })
  const store = new TmCommStore(databasePath)
  const service = new TmCommService(store, config)
  const httpServer = await listenTmCommHttpServer(createTmCommHttpServer(service, config), config)

  return {
    baseUrl: httpServer.tmCommBaseUrl,
    origin,
    store,
    service,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()))
      })
      store.close()
    }
  }
}

async function apiRequest(
  server: TestServer,
  path: string,
  init: RequestInit & { token?: string } = {}
) {
  const headers = new Headers(init.headers)
  headers.set('Origin', server.origin)
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  if (init.token) {
    headers.set('Cookie', `${TM_COMM_COOKIE_NAME}=${init.token}`)
  }
  const response = await fetch(`${server.baseUrl}${path}`, {
    ...init,
    headers
  })
  const text = await response.text()
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    // Non-JSON response
  }
  return {
    status: response.status,
    json,
    text,
    token: cookieValue(response.headers.getSetCookie(), TM_COMM_COOKIE_NAME)
  }
}

async function authenticateWallet(
  server: TestServer,
  wallet: ReturnType<typeof createTmCommEphemeralWallet>
) {
  const challenge = await apiRequest(server, '/v1/tm-comm/challenges', { method: 'POST' })
  expect(challenge.status).toBe(201)
  const payload = challenge.json as { challengeId: string; canonicalMessage: string }

  const session = await apiRequest(server, '/v1/tm-comm/sessions', {
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
    principalId: (session.json.principal as { id: string }).id,
    principal: session.json.principal as { id: string; kind: string; walletAddress: string }
  }
}

describe('TM-COMM A0 staging operator identity restart persistence', () => {
  test('reproduces finding and verifies complete restart durability lifecycle', async () => {
    const dataDir = makeTempDirectory()
    const dbPath = join(dataDir, 'tm-comm-staging.sqlite')
    const credentialPath = join(dataDir, 'operator-wallet.json')
    const origin = 'http://127.0.0.1:5174'
    const config = loadTmCommRuntimeConfig({
      databasePath: dbPath,
      expectedOrigin: origin,
      listenHost: '127.0.0.1',
      listenPort: 0
    })

    // STEP 1: First Start (fresh DB and fresh credential)
    let store = new TmCommStore(dbPath)
    const operator1 = resolveTmCommOperatorCredential({ credentialPath, store })
    expect(existsSync(credentialPath)).toBe(true)

    const bootstrap1 = bootstrapTmCommStaging(store, config, {
      address: operator1.address,
      publicKeyHex: operator1.publicKeyHex
    })
    const initialOperatorPrincipal = store.findOperatorPrincipal()
    expect(initialOperatorPrincipal).not.toBeNull()
    expect(initialOperatorPrincipal?.id).toBe(bootstrap1.operatorPrincipalId)
    expect(initialOperatorPrincipal?.walletAddress).toBe(operator1.address)
    store.close()

    // Start HTTP server for Phase 1
    let runningServer = await startServer(dbPath, origin)
    const guestWallet = createTmCommEphemeralWallet()
    const guestSession = await authenticateWallet(runningServer, guestWallet)

    // Guest binds conversation using enrollment token
    const bindResponse = await apiRequest(runningServer, '/v1/tm-comm/bindings', {
      method: 'POST',
      token: guestSession.token,
      body: JSON.stringify({ enrollmentToken: bootstrap1.enrollments[0].enrollmentToken })
    })
    expect(bindResponse.status).toBe(201)
    const conversationId = (bindResponse.json.conversation as { id: string }).id

    // Guest sends a message in conversation
    const sendResponse = await apiRequest(
      runningServer,
      `/v1/tm-comm/conversations/${conversationId}/messages`,
      {
        method: 'POST',
        token: guestSession.token,
        body: JSON.stringify({
          clientMessageId: 'msg-restart-1',
          body: 'Hello operator before restart'
        })
      }
    )
    expect(sendResponse.status).toBe(201)
    const messageId = (sendResponse.json as { id: string }).id

    // Stop server and close store
    await runningServer.close()

    // STEP 2: Staging Restart against existing DB
    store = new TmCommStore(dbPath)
    const operatorRestart = resolveTmCommOperatorCredential({ credentialPath, store })

    // Invariant 1: Same cryptographic identity
    expect(operatorRestart.secretHex).toBe(operator1.secretHex)
    expect(operatorRestart.publicKeyHex).toBe(operator1.publicKeyHex)
    expect(operatorRestart.address).toBe(operator1.address)

    // Run bootstrap on restarted store
    const bootstrapRestart = bootstrapTmCommStaging(store, config, {
      address: operatorRestart.address,
      publicKeyHex: operatorRestart.publicKeyHex
    })
    store.close()

    // Invariant 2: Same Principal
    expect(bootstrapRestart.operatorPrincipalId).toBe(initialOperatorPrincipal?.id)
    expect(bootstrapRestart.operatorAddress).toBe(initialOperatorPrincipal?.walletAddress)

    // Start HTTP server for Phase 2 (Restarted Server)
    runningServer = await startServer(dbPath, origin)

    // Authenticate as the operator
    const operatorSession = await authenticateWallet(runningServer, operatorRestart)

    // Invariant 3: Zero accidental customer Principal creation
    expect(operatorSession.principalId).toBe(initialOperatorPrincipal?.id)
    expect(operatorSession.principal.id).toBe(initialOperatorPrincipal?.id)
    expect(operatorSession.principal.kind).toBe('operator')
    const storedByAddress = runningServer.store.findPrincipalByAddress(operatorRestart.address)
    expect(storedByAddress?.id).toBe(initialOperatorPrincipal?.id)
    expect(storedByAddress?.kind).toBe('operator')

    // Invariant 4: Same memberships and listable conversations
    const listConversations = await apiRequest(runningServer, '/v1/tm-comm/conversations', {
      token: operatorSession.token
    })
    expect(listConversations.status).toBe(200)
    const conversations = listConversations.json.conversations as Array<{ id: string }>
    expect(conversations.some((c) => c.id === conversationId)).toBe(true)

    // Invariant 5: History accessible across restart
    const listMessages = await apiRequest(
      runningServer,
      `/v1/tm-comm/conversations/${conversationId}/messages`,
      {
        token: operatorSession.token
      }
    )
    expect(listMessages.status).toBe(200)
    const messages = listMessages.json.messages as Array<{
      id: string
      body: string
      status: string
    }>
    expect(messages).toHaveLength(1)
    expect(messages[0].id).toBe(messageId)
    expect(messages[0].body).toBe('Hello operator before restart')
    expect(messages[0].status).toBe('accepted')

    // Invariant 6: Zero loss of access - operator can issue legitimate delivery receipt
    const deliveryReceipt = await apiRequest(
      runningServer,
      `/v1/tm-comm/messages/${messageId}/receipts`,
      {
        method: 'PUT',
        token: operatorSession.token,
        body: JSON.stringify({ state: 'delivered' })
      }
    )
    expect(deliveryReceipt.status).toBe(200)

    // Operator issues legitimate read receipt
    const readReceipt = await apiRequest(
      runningServer,
      `/v1/tm-comm/messages/${messageId}/receipts`,
      {
        method: 'PUT',
        token: operatorSession.token,
        body: JSON.stringify({ state: 'read' })
      }
    )
    expect(readReceipt.status).toBe(200)

    // Verify aggregate message status reached 'read'
    const messagesAfterReceipt = await apiRequest(
      runningServer,
      `/v1/tm-comm/conversations/${conversationId}/messages`,
      {
        token: operatorSession.token
      }
    )
    const updated = (messagesAfterReceipt.json.messages as Array<{ status: string }>)[0]
    expect(updated.status).toBe('read')

    await runningServer.close()
  })

  test('credential file absent + DB new -> bootstrap permitted and writes credential', () => {
    const dataDir = makeTempDirectory()
    const dbPath = join(dataDir, 'fresh.sqlite')
    const credentialPath = join(dataDir, 'operator-wallet.json')
    const config = loadTmCommRuntimeConfig({
      databasePath: dbPath,
      expectedOrigin: 'http://127.0.0.1:5174',
      listenHost: '127.0.0.1',
      listenPort: 0
    })

    const store = new TmCommStore(dbPath)
    try {
      expect(existsSync(credentialPath)).toBe(false)
      expect(store.findOperatorPrincipal()).toBeNull()

      const operator = resolveTmCommOperatorCredential({ credentialPath, store })
      expect(existsSync(credentialPath)).toBe(true)
      expect(operator.address).toMatch(/^ecash:/)
      expect(operator.publicKeyHex).toMatch(/^[0-9a-f]{66}$/)
      expect(operator.secretHex).toMatch(/^[0-9a-f]{64}$/)

      const content = JSON.parse(readFileSync(credentialPath, 'utf8')) as {
        address: string
        publicKeyHex: string
        secretHex: string
      }
      expect(content.address).toBe(operator.address)
      expect(content.publicKeyHex).toBe(operator.publicKeyHex)
      expect(content.secretHex).toBe(operator.secretHex)

      const bootstrap = bootstrapTmCommStaging(store, config, operator)
      expect(bootstrap.operatorPrincipalId).toBeDefined()
      expect(bootstrap.operatorAddress).toBe(operator.address)
    } finally {
      store.close()
    }
  })

  test('credential file absent + DB existing with previous operator -> fail closed', () => {
    const dataDir = makeTempDirectory()
    const dbPath = join(dataDir, 'existing.sqlite')
    const credentialPath = join(dataDir, 'operator-wallet.json')

    const store = new TmCommStore(dbPath)
    try {
      // First bootstrap creates the operator
      const initialWallet = resolveTmCommOperatorCredential({ credentialPath, store })
      const config = loadTmCommRuntimeConfig({
        databasePath: dbPath,
        expectedOrigin: 'http://127.0.0.1:5174',
        listenHost: '127.0.0.1',
        listenPort: 0
      })
      bootstrapTmCommStaging(store, config, initialWallet)
      const storedOperator = store.findOperatorPrincipal()
      expect(storedOperator).not.toBeNull()

      // Now remove the credential file simulating loss or mismatched staging directory
      rmSync(credentialPath, { force: true })
      expect(existsSync(credentialPath)).toBe(false)

      // Must fail closed without silently creating a substitute operator
      expect(() =>
        resolveTmCommOperatorCredential({ credentialPath, store })
      ).toThrow(/Operator credential file is missing.*Refusing to regenerate a substitute operator/i)

      // Verify the stored operator was NOT modified or replaced
      const postAttemptOperator = store.findOperatorPrincipal()
      expect(postAttemptOperator?.id).toBe(storedOperator?.id)
      expect(postAttemptOperator?.walletAddress).toBe(storedOperator?.walletAddress)
      expect(postAttemptOperator?.publicKeyHex).toBe(storedOperator?.publicKeyHex)
    } finally {
      store.close()
    }
  })

  test('credential corrupt -> fail closed', () => {
    const dataDir = makeTempDirectory()
    const dbPath = join(dataDir, 'corrupt.sqlite')
    const credentialPath = join(dataDir, 'operator-wallet.json')
    const store = new TmCommStore(dbPath)

    try {
      // Case 1: Corrupted JSON syntax
      writeFileSync(credentialPath, '{"broken json: true', { encoding: 'utf8' })
      expect(() => resolveTmCommOperatorCredential({ credentialPath, store })).toThrow(
        /corrupt or contains invalid JSON/i
      )

      // Case 2: Non-object JSON
      writeFileSync(credentialPath, JSON.stringify('a plain string'), { encoding: 'utf8' })
      expect(() => resolveTmCommOperatorCredential({ credentialPath, store })).toThrow(
        /corrupt: expected a JSON object/i
      )

      // Case 3: Missing secretHex
      writeFileSync(credentialPath, JSON.stringify({ notice: 'staging only' }), {
        encoding: 'utf8'
      })
      expect(() => resolveTmCommOperatorCredential({ credentialPath, store })).toThrow(
        /missing required string field "secretHex"/i
      )

      // Case 4: Invalid secretHex length
      writeFileSync(credentialPath, JSON.stringify({ secretHex: '1234abcd' }), {
        encoding: 'utf8'
      })
      expect(() => resolveTmCommOperatorCredential({ credentialPath, store })).toThrow(
        /must be a 64-character hex string/i
      )

      // Case 5: Invalid secp256k1 scalar (e.g. all 0xff)
      writeFileSync(
        credentialPath,
        JSON.stringify({ secretHex: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' }),
        { encoding: 'utf8' }
      )
      expect(() => resolveTmCommOperatorCredential({ credentialPath, store })).toThrow(
        /not a valid secp256k1 scalar/i
      )

      // Case 6: Address mismatch in file
      const validWallet = createTmCommEphemeralWallet()
      writeFileSync(
        credentialPath,
        JSON.stringify({
          secretHex: validWallet.secretHex,
          address: 'ecash:qqtamperedaddress00000000000000000000000000'
        }),
        { encoding: 'utf8' }
      )
      expect(() => resolveTmCommOperatorCredential({ credentialPath, store })).toThrow(
        /does not match derived address/i
      )
    } finally {
      store.close()
    }
  })

  test('credential deriving another identity -> fail closed', () => {
    const dataDir = makeTempDirectory()
    const dbPath = join(dataDir, 'mismatch.sqlite')
    const credentialPath = join(dataDir, 'operator-wallet.json')
    const store = new TmCommStore(dbPath)

    try {
      const config = loadTmCommRuntimeConfig({
        databasePath: dbPath,
        expectedOrigin: 'http://127.0.0.1:5174',
        listenHost: '127.0.0.1',
        listenPort: 0
      })

      // Bootstrap operator A into the database
      const operatorA = createTmCommDeterministicWallet(
        '1111111111111111111111111111111111111111111111111111111111111111'
      )
      bootstrapTmCommStaging(store, config, operatorA)

      // Credential file contains valid key for operator B
      const operatorB = createTmCommDeterministicWallet(
        '2222222222222222222222222222222222222222222222222222222222222222'
      )
      mkdirSync(dirname(credentialPath), { recursive: true })
      writeFileSync(
        credentialPath,
        JSON.stringify({
          notice: 'STAGING ONLY. Fictitious operator wallet.',
          address: operatorB.address,
          publicKeyHex: operatorB.publicKeyHex,
          secretHex: operatorB.secretHex
        }),
        { encoding: 'utf8', mode: 0o600 }
      )

      // resolveTmCommOperatorCredential must fail closed
      expect(() => resolveTmCommOperatorCredential({ credentialPath, store })).toThrow(
        /does not match the stored operator principal in database/i
      )

      // bootstrapTmCommStaging must also fail closed with OPERATOR_IDENTITY_MISMATCH
      expect(() => bootstrapTmCommStaging(store, config, operatorB)).toThrow(TmCommError)
      try {
        bootstrapTmCommStaging(store, config, operatorB)
      } catch (err) {
        expect(err).toBeInstanceOf(TmCommError)
        expect((err as TmCommError).code).toBe(TM_COMM_ERROR_CODES.CONFLICT)
        expect((err as TmCommError).reasonCode).toBe('OPERATOR_IDENTITY_MISMATCH')
      }
    } finally {
      store.close()
    }
  })

  test('P2-8: two concurrent processes on new dir/DB converge on exact winning identity', async () => {
    const dataDir = makeTempDirectory()
    const dbPath = join(dataDir, 'concurrent.sqlite')
    const credentialPath = join(dataDir, 'operator-wallet.json')

    const childCode = `
import { TmCommStore } from './server/tmComm/tmCommStore.ts';
import { resolveTmCommOperatorCredential } from './server/tmComm/tmCommTestUtils.ts';
const store = new TmCommStore(process.argv[1]);
const wallet = resolveTmCommOperatorCredential({ credentialPath: process.argv[2], store });
process.stdout.write(JSON.stringify(wallet));
`

    function runResolverProcess(): Promise<{ address: string; publicKeyHex: string; secretHex: string }> {
      return new Promise((resolve, reject) => {
        const cp = spawn('npx', ['tsx', '-e', childCode, dbPath, credentialPath], {
          stdio: ['ignore', 'pipe', 'inherit']
        })
        let stdout = ''
        cp.stdout.on('data', (d) => {
          stdout += String(d)
        })
        cp.on('close', (code) => {
          if (code === 0) {
            try {
              resolve(JSON.parse(stdout))
            } catch (e) {
              reject(e)
            }
          } else {
            reject(new Error(`Child process failed with code ${code}`))
          }
        })
      })
    }

    // Run two processes truly concurrently against uninitialized directory and DB
    const [walletA, walletB] = await Promise.all([runResolverProcess(), runResolverProcess()])

    // Both processes MUST converge on the exact same identity
    expect(walletA.address).toBe(walletB.address)
    expect(walletA.publicKeyHex).toBe(walletB.publicKeyHex)
    expect(walletA.secretHex).toBe(walletB.secretHex)

    // Exactly 1 credential persisted
    expect(existsSync(credentialPath)).toBe(true)
    const persisted = JSON.parse(readFileSync(credentialPath, 'utf8'))
    expect(persisted.address).toBe(walletA.address)
    expect(persisted.secretHex).toBe(walletA.secretHex)

    // Bootstrap into SQLite
    const store = new TmCommStore(dbPath)
    try {
      const config = loadTmCommRuntimeConfig({
        databasePath: dbPath,
        expectedOrigin: 'http://127.0.0.1:5174',
        listenHost: '127.0.0.1',
        listenPort: 0
      })
      const fullWallet = createTmCommDeterministicWallet(walletA.secretHex)
      const boot = bootstrapTmCommStaging(store, config, fullWallet)
      expect(boot.operatorPrincipalId).toBeDefined()

      // Exactly one operator Principal in SQLite
      const operator = store.findOperatorPrincipal()
      expect(operator).not.toBeNull()
      expect(operator?.walletAddress).toBe(walletA.address)
      expect(operator?.kind).toBe('operator')

      // Zero accidental customer Principals
      const db = new DatabaseSync(dbPath)
      try {
        const rows = db.prepare('SELECT * FROM tm_comm_principals').all() as Array<{ kind: string }>
        expect(rows.length).toBe(1)
        expect(rows[0].kind).toBe('operator')
      } finally {
        db.close()
      }
    } finally {
      store.close()
    }
  }, 15000)

  test('P2-8: loser on EEXIST reloads winner instead of generating a new identity', () => {
    const dataDir = makeTempDirectory()
    const dbPath = join(dataDir, 'eexist-loser.sqlite')
    const credentialPath = join(dataDir, 'operator-wallet.json')
    const store = new TmCommStore(dbPath)

    try {
      // Create winner credential
      const winner = createTmCommEphemeralWallet()
      mkdirSync(dirname(credentialPath), { recursive: true, mode: 0o700 })
      writeFileSync(
        credentialPath,
        JSON.stringify({
          notice: 'STAGING ONLY. Fictitious operator wallet. Never a production key.',
          address: winner.address,
          publicKeyHex: winner.publicKeyHex,
          secretHex: winner.secretHex
        }),
        { encoding: 'utf8', mode: 0o600 }
      )

      // Loser process calls resolveTmCommOperatorCredential
      const loser = resolveTmCommOperatorCredential({ credentialPath, store })
      expect(loser.address).toBe(winner.address)
      expect(loser.publicKeyHex).toBe(winner.publicKeyHex)
      expect(loser.secretHex).toBe(winner.secretHex)

      // File was not modified/replaced
      const content = JSON.parse(readFileSync(credentialPath, 'utf8'))
      expect(content.address).toBe(winner.address)
      expect(content.secretHex).toBe(winner.secretHex)
    } finally {
      store.close()
    }
  })

  test('P2-8: read during partial write is retried until valid JSON is available', async () => {
    const dataDir = makeTempDirectory()
    const dbPath = join(dataDir, 'partial-write-retry.sqlite')
    const credentialPath = join(dataDir, 'operator-wallet.json')
    const store = new TmCommStore(dbPath)

    try {
      mkdirSync(dirname(credentialPath), { recursive: true, mode: 0o700 })
      // Write partial incomplete JSON to simulate winner inode creation in progress
      writeFileSync(credentialPath, '{"notice": "STAGING ONLY"', { encoding: 'utf8', mode: 0o600 })

      const fullWallet = createTmCommEphemeralWallet()
      const payload = JSON.stringify({
        notice: 'STAGING ONLY. Fictitious operator wallet. Never a production key.',
        address: fullWallet.address,
        publicKeyHex: fullWallet.publicKeyHex,
        secretHex: fullWallet.secretHex
      })

      // Spawn background worker thread to complete the write after 40ms
      const worker = new Worker(
        `
        const { writeFileSync } = require('node:fs');
        setTimeout(() => {
          writeFileSync(process.env.TEST_CRED_PATH, process.env.TEST_PAYLOAD, { encoding: 'utf8', mode: 0o600 });
        }, 40);
        `,
        {
          eval: true,
          env: {
            ...process.env,
            TEST_CRED_PATH: credentialPath,
            TEST_PAYLOAD: payload
          }
        }
      )

      try {
        const resolved = resolveTmCommOperatorCredential({
          credentialPath,
          store,
          retryDelayMs: 15,
          maxRetries: 30
        })

        expect(resolved.address).toBe(fullWallet.address)
        expect(resolved.publicKeyHex).toBe(fullWallet.publicKeyHex)
        expect(resolved.secretHex).toBe(fullWallet.secretHex)
      } finally {
        await worker.terminate()
      }
    } finally {
      store.close()
    }
  })

  test('P2-8: permanent partial/corrupt file fails closed without regenerating or overwriting', () => {
    const dataDir = makeTempDirectory()
    const dbPath = join(dataDir, 'permanent-corrupt.sqlite')
    const credentialPath = join(dataDir, 'operator-wallet.json')
    const store = new TmCommStore(dbPath)

    try {
      mkdirSync(dirname(credentialPath), { recursive: true, mode: 0o700 })
      const corruptPayload = '{"notice": "STAGING ONLY", "incomplete": true'
      writeFileSync(credentialPath, corruptPayload, { encoding: 'utf8', mode: 0o600 })

      expect(() =>
        resolveTmCommOperatorCredential({
          credentialPath,
          store,
          retryDelayMs: 5,
          maxRetries: 3
        })
      ).toThrow(/could not be loaded or validated after 3 attempts/i)

      // Existing corrupt file was NEVER overwritten or truncated
      expect(readFileSync(credentialPath, 'utf8')).toBe(corruptPayload)
      // Database has no operator
      expect(store.findOperatorPrincipal()).toBeNull()
    } finally {
      store.close()
    }
  })

  test('P2-8: existing credential file is never truncated or overwritten', () => {
    const dataDir = makeTempDirectory()
    const dbPath = join(dataDir, 'no-truncate.sqlite')
    const credentialPath = join(dataDir, 'operator-wallet.json')
    const store = new TmCommStore(dbPath)

    try {
      const originalWallet = createTmCommEphemeralWallet()
      mkdirSync(dirname(credentialPath), { recursive: true, mode: 0o700 })
      const originalText = `${JSON.stringify({
        notice: 'STAGING ONLY. Fictitious operator wallet. Never a production key.',
        address: originalWallet.address,
        publicKeyHex: originalWallet.publicKeyHex,
        secretHex: originalWallet.secretHex
      }, null, 2)}\n`

      writeFileSync(credentialPath, originalText, { encoding: 'utf8', mode: 0o600 })

      const resolved = resolveTmCommOperatorCredential({ credentialPath, store })
      expect(resolved.address).toBe(originalWallet.address)

      // Ensure exact content is intact
      expect(readFileSync(credentialPath, 'utf8')).toBe(originalText)
    } finally {
      store.close()
    }
  })

  describe('P2-12: Enforce parent directory mode 0700', () => {
    test('directorio preexistente 0777 -> resolver -> queda 0700', () => {
      const dataDir = makeTempDirectory()
      const parentDir = join(dataDir, 'staging-0777')
      mkdirSync(parentDir, { recursive: true })
      chmodSync(parentDir, 0o777)
      expect(statSync(parentDir).mode & 0o777).toBe(0o777)

      const dbPath = join(dataDir, 'test.sqlite')
      const credentialPath = join(parentDir, 'operator-wallet.json')
      const store = new TmCommStore(dbPath)
      try {
        const wallet = resolveTmCommOperatorCredential({ credentialPath, store })
        expect(wallet.address).toBeDefined()
        expect(statSync(parentDir).mode & 0o777).toBe(0o700)
      } finally {
        store.close()
      }
    })

    test('directorio 0755 -> queda 0700', () => {
      const dataDir = makeTempDirectory()
      const parentDir = join(dataDir, 'staging-0755')
      mkdirSync(parentDir, { recursive: true })
      chmodSync(parentDir, 0o755)
      expect(statSync(parentDir).mode & 0o777).toBe(0o755)

      const dbPath = join(dataDir, 'test.sqlite')
      const credentialPath = join(parentDir, 'operator-wallet.json')
      const store = new TmCommStore(dbPath)
      try {
        const wallet = resolveTmCommOperatorCredential({ credentialPath, store })
        expect(wallet.address).toBeDefined()
        expect(statSync(parentDir).mode & 0o777).toBe(0o700)
      } finally {
        store.close()
      }
    })

    test('credential ya existente válida -> también corrige/verifica el parent', () => {
      const dataDir = makeTempDirectory()
      const parentDir = join(dataDir, 'staging-existing')
      mkdirSync(parentDir, { recursive: true, mode: 0o700 })

      const dbPath = join(dataDir, 'test.sqlite')
      const credentialPath = join(parentDir, 'operator-wallet.json')
      const store = new TmCommStore(dbPath)
      try {
        // Initial creation
        const originalWallet = resolveTmCommOperatorCredential({ credentialPath, store })
        expect(statSync(parentDir).mode & 0o777).toBe(0o700)

        // Simulate external tampering or relaxed permissions on existing directory
        chmodSync(parentDir, 0o755)
        expect(statSync(parentDir).mode & 0o777).toBe(0o755)

        // Resolve again with valid existing credential
        const reloaded = resolveTmCommOperatorCredential({ credentialPath, store })
        expect(reloaded.address).toBe(originalWallet.address)
        // Must correct and enforce 0o700
        expect(statSync(parentDir).mode & 0o777).toBe(0o700)
      } finally {
        store.close()
      }
    })

    test('restart normal -> sigue 0700', () => {
      const dataDir = makeTempDirectory()
      const parentDir = join(dataDir, 'staging-restart')
      const dbPath = join(dataDir, 'test.sqlite')
      const credentialPath = join(parentDir, 'operator-wallet.json')
      const store1 = new TmCommStore(dbPath)
      let firstAddress = ''
      try {
        const wallet1 = resolveTmCommOperatorCredential({ credentialPath, store: store1 })
        expect(statSync(parentDir).mode & 0o777).toBe(0o700)
        firstAddress = wallet1.address
      } finally {
        store1.close()
      }

      // Restart with fresh store on same db
      const store2 = new TmCommStore(dbPath)
      try {
        const wallet2 = resolveTmCommOperatorCredential({ credentialPath, store: store2 })
        expect(wallet2.address).toBe(firstAddress)
        expect(statSync(parentDir).mode & 0o777).toBe(0o700)
      } finally {
        store2.close()
      }
    })

    test('fallo al asegurar permisos -> fail closed, no continúa usando la credencial', () => {
      const dataDir = makeTempDirectory()
      const blockedParentDir = join(dataDir, 'staging-file-block')
      writeFileSync(blockedParentDir, 'not-a-directory')

      const dbPath = join(dataDir, 'test.sqlite')
      const credentialPath = join(blockedParentDir, 'operator-wallet.json')
      const store = new TmCommStore(dbPath)

      try {
        expect(() =>
          resolveTmCommOperatorCredential({ credentialPath, store })
        ).toThrow(/Failed to secure parent directory for operator credential at/i)

        expect(store.findOperatorPrincipal()).toBeNull()
        expect(existsSync(credentialPath)).toBe(false)
      } finally {
        store.close()
      }
    })

    test('fallo determinista de permisos (EACCES en chmodSync) -> fail closed, no crea ni usa credencial', () => {
      const dataDir = makeTempDirectory()
      const parentDir = join(dataDir, 'staging-permission-denied-chmod')
      const dbPath = join(dataDir, 'test.sqlite')
      const credentialPath = join(parentDir, 'operator-wallet.json')
      const store = new TmCommStore(dbPath)

      setFsMockState({
        targetDir: parentDir,
        errorCode: 'EACCES',
        operation: 'chmodSync',
        invoked: false
      })

      try {
        expect(() =>
          resolveTmCommOperatorCredential({ credentialPath, store })
        ).toThrow(/Failed to secure parent directory for operator credential at.*EACCES/i)

        // Mock fue realmente invocado por ensureSecureParentDirectory
        const mockState = getFsMockState()
        expect(mockState?.invoked).toBe(true)

        // La base de datos no contiene operador
        expect(store.findOperatorPrincipal()).toBeNull()

        // El archivo de credencial no fue creado
        expect(existsSync(credentialPath)).toBe(false)
      } finally {
        resetFsMock()
        store.close()
      }
    })

    test('fallo determinista de permisos (EPERM en mkdirSync) -> fail closed, no crea ni usa credencial', () => {
      const dataDir = makeTempDirectory()
      const parentDir = join(dataDir, 'staging-permission-denied-mkdir')
      const dbPath = join(dataDir, 'test.sqlite')
      const credentialPath = join(parentDir, 'operator-wallet.json')
      const store = new TmCommStore(dbPath)

      setFsMockState({
        targetDir: parentDir,
        errorCode: 'EPERM',
        operation: 'mkdirSync',
        invoked: false
      })

      try {
        expect(() =>
          resolveTmCommOperatorCredential({ credentialPath, store })
        ).toThrow(/Failed to secure parent directory for operator credential at.*EPERM/i)

        // Mock fue realmente invocado por ensureSecureParentDirectory
        const mockState = getFsMockState()
        expect(mockState?.invoked).toBe(true)

        // La base de datos no contiene operador
        expect(store.findOperatorPrincipal()).toBeNull()

        // El archivo de credencial no fue creado
        expect(existsSync(credentialPath)).toBe(false)
      } finally {
        resetFsMock()
        store.close()
      }
    })
  })
})
