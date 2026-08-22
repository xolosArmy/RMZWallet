import { fork, type ChildProcess } from 'node:child_process'
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import type { Tm1PublicationRecoveryRecord } from '../../../src/integrations/tonalliMemo/recovery/tm1PublicationRecoveryModel'
import {
  createTm1SqlitePublicationRecoveryStore,
  type Tm1SqlitePublicationRecoveryStore
} from './tm1SqlitePublicationRecoveryStore'
import {
  outcomeUnknownRecord,
  preparedRecord,
  signingPendingRecord
} from './tm1SqliteTestFixtures'

const workerPath = fileURLToPath(new URL(
  '../../../scripts/tm1-recovery-store-crash-worker.ts',
  import.meta.url
))
const temporaryDirectories: string[] = []
const liveWorkers = new Set<ChildProcess>()

afterEach(async () => {
  await Promise.all([...liveWorkers].map(killWorker))
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('TM1 SQLite real-file and process behavior', () => {
  test('persists through close/reopen and a WAL checkpoint', async () => {
    const { databasePath } = emptyPath()
    const record = outcomeUnknownRecord()
    const first = openStore(databasePath)
    await first.create({ record })
    first.close()

    const checkpoint = new DatabaseSync(databasePath, { allowExtension: false })
    const result = checkpoint.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    expect(result).toMatchObject({ busy: 0 })
    checkpoint.close()

    const reopened = openStore(databasePath)
    await expect(reopened.load(record.publicationId)).resolves.toEqual(record)
    reopened.close()
  })

  test('supports two connections while preserving CAS', async () => {
    const { databasePath } = emptyPath()
    const first = openStore(databasePath)
    const second = openStore(databasePath)
    const record = preparedRecord()
    await first.create({ record })

    const firstSnapshot = await first.load(record.publicationId) as Tm1PublicationRecoveryRecord
    const secondSnapshot = await second.load(record.publicationId) as Tm1PublicationRecoveryRecord
    const claimed = await first.claimOwnership({
      publicationId: record.publicationId,
      expectedRevision: firstSnapshot.revision,
      expectedOwnerEpoch: firstSnapshot.ownerEpoch,
      nextOwnerEpoch: 1
    }) as Tm1PublicationRecoveryRecord

    await expect(second.claimOwnership({
      publicationId: record.publicationId,
      expectedRevision: secondSnapshot.revision,
      expectedOwnerEpoch: secondSnapshot.ownerEpoch,
      nextOwnerEpoch: 2
    })).rejects.toMatchObject({ code: 'REVISION_MISMATCH' })
    await expect(second.load(record.publicationId)).resolves.toEqual(claimed)
    first.close()
    second.close()
  })

  test('normalizes a bounded BUSY timeout and leaves state unchanged', async () => {
    const { databasePath } = emptyPath()
    const setup = openStore(databasePath)
    const record = preparedRecord()
    await setup.create({ record })
    setup.close()

    const locker = new DatabaseSync(databasePath, {
      allowExtension: false,
      timeout: 20
    })
    locker.exec('BEGIN IMMEDIATE')
    const contender = openStore(databasePath, 20)
    await expect(contender.claimOwnership({
      publicationId: record.publicationId,
      expectedRevision: record.revision,
      expectedOwnerEpoch: record.ownerEpoch,
      nextOwnerEpoch: 1
    })).rejects.toMatchObject({ code: 'RECOVERY_STORE_FAILED' })
    locker.exec('ROLLBACK')
    locker.close()
    await expect(contender.load(record.publicationId)).resolves.toEqual(record)
    contender.close()
  })

  test.skipIf(process.platform === 'win32')(
    'fails closed when an existing database is read-only',
    async () => {
      const { databasePath } = emptyPath()
      const store = openStore(databasePath)
      await store.create({ record: preparedRecord() })
      store.close()
      chmodSync(databasePath, 0o400)

      let thrown: unknown
      try {
        openStore(databasePath)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toMatchObject({ code: 'RECOVERY_STORE_FAILED' })
    }
  )

  test('normalizes a non-database/corrupt file without leaking its path', () => {
    const { databasePath } = emptyPath()
    writeFileSync(databasePath, 'not-a-sqlite-database', { mode: 0o600 })

    let thrown: unknown
    try {
      openStore(databasePath)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toMatchObject({
      code: 'RECOVERY_STORE_FAILED',
      message: 'RECOVERY_STORE_FAILED'
    })
  })

  test('rolls back a real transaction when transition validation throws', async () => {
    const { databasePath } = emptyPath()
    const store = openStore(databasePath)
    const prepared = preparedRecord()
    await store.create({ record: prepared })

    await expect(store.commitExecutionEvidence({
      publicationId: prepared.publicationId,
      expectedRevision: prepared.revision,
      expectedOwnerEpoch: prepared.ownerEpoch,
      nextRecord: {
        ...signingPendingRecord(),
        revision: prepared.revision + 2
      } as Tm1PublicationRecoveryRecord,
      newlyConsumedCapabilityIds: []
    })).rejects.toMatchObject({ code: 'INVALID_RECOVERY_TRANSITION' })
    store.close()

    const reopened = openStore(databasePath)
    await expect(reopened.load(prepared.publicationId)).resolves.toEqual(prepared)
    reopened.close()
  })

  test('process death before COMMIT rolls back the mutation', async () => {
    const { databasePath } = emptyPath()
    const setup = openStore(databasePath)
    setup.close()

    const worker = spawnWorker('hold-before-commit', databasePath)
    const message = await nextMessage(worker)
    expect(message.status).toBe('before-commit')
    expect(typeof message.previous).toBe('number')
    await killWorker(worker)

    const database = new DatabaseSync(databasePath, { allowExtension: false })
    const current = database.prepare(`
      SELECT created_at
      FROM tm1_store_metadata
      WHERE singleton_id = 1
    `).get()?.created_at
    database.close()
    expect(current).toBe(message.previous)
  })

  test('process death after COMMIT preserves the publication on restart', async () => {
    const { directory, databasePath } = emptyPath()
    const setup = openStore(databasePath)
    setup.close()
    const record = preparedRecord()
    const payloadPath = join(directory, 'record.json')
    writeFileSync(payloadPath, JSON.stringify(record), { mode: 0o600 })

    const worker = spawnWorker('create-and-hold', databasePath, payloadPath)
    await expect(nextMessage(worker)).resolves.toMatchObject({
      status: 'after-commit',
      publicationId: record.publicationId
    })
    await killWorker(worker)

    const reopened = openStore(databasePath)
    await expect(reopened.load(record.publicationId)).resolves.toEqual(record)
    reopened.close()
  })

  test('a stale process cannot commit after ownership takeover', async () => {
    const { databasePath } = emptyPath()
    const initial = outcomeUnknownRecord()
    const setup = openStore(databasePath)
    await setup.create({ record: initial })
    setup.close()

    const worker = spawnWorker('stale-recovery', databasePath, initial.publicationId)
    await expect(nextMessage(worker)).resolves.toMatchObject({
      status: 'loaded',
      revision: initial.revision,
      ownerEpoch: initial.ownerEpoch
    })

    const owner = openStore(databasePath)
    const claimed = await owner.claimOwnership({
      publicationId: initial.publicationId,
      expectedRevision: initial.revision,
      expectedOwnerEpoch: initial.ownerEpoch,
      nextOwnerEpoch: 1
    }) as Tm1PublicationRecoveryRecord
    owner.close()

    worker.send?.({ command: 'commit' })
    await expect(nextMessage(worker)).resolves.toMatchObject({
      status: 'rejected',
      code: 'REVISION_MISMATCH'
    })
    await killWorker(worker)

    const reopened = openStore(databasePath)
    await expect(reopened.load(initial.publicationId)).resolves.toEqual(claimed)
    reopened.close()
  })

  test('a restart worker loads exact outcomeUnknown evidence only', async () => {
    const { databasePath } = emptyPath()
    const record = outcomeUnknownRecord()
    const setup = openStore(databasePath)
    await setup.create({ record })
    setup.close()

    const worker = spawnWorker('load-only', databasePath, record.publicationId)
    await expect(nextMessage(worker)).resolves.toEqual({
      status: 'loaded',
      record: JSON.parse(JSON.stringify(record))
    })
    await killWorker(worker)
  })

  test('the worker and store contain no signer or network dispatch route', () => {
    const worker = readFileSync(workerPath, 'utf8')
    const store = readFileSync(
      fileURLToPath(new URL('./tm1SqlitePublicationRecoveryStore.ts', import.meta.url)),
      'utf8'
    )
    const combined = `${worker}\n${store}`

    expect(combined).not.toMatch(/P2pkhSigner|ChronikClient|broadcastTx|\.broadcast\s*\(|\.sign\s*\(/)
    expect(worker).not.toMatch(/rebroadcast|deliveryTransport|authorization core/i)
  })

  test('client production sources do not import Node SQLite or the store', () => {
    const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
    const clientFiles = productionTypeScriptFiles(join(repositoryRoot, 'src'))
    const combined = clientFiles.map(path => readFileSync(path, 'utf8')).join('\n')

    expect(combined).not.toContain("from 'node:sqlite'")
    expect(combined).not.toContain('tm1SqlitePublicationRecoveryStore')
    expect(combined).not.toContain('server/tonalliMemo/recovery')
  })
})

function emptyPath(): Readonly<{ directory: string; databasePath: string }> {
  const directory = mkdtempSync(join(tmpdir(), 'rmz-tm1-sqlite-integration-'))
  temporaryDirectories.push(directory)
  return Object.freeze({ directory, databasePath: join(directory, 'recovery.db') })
}

function openStore(
  databasePath: string,
  busyTimeoutMs?: number
): Tm1SqlitePublicationRecoveryStore {
  return createTm1SqlitePublicationRecoveryStore({
    databasePath,
    ...(busyTimeoutMs === undefined ? {} : { busyTimeoutMs }),
    now: () => 1_000
  })
}

function spawnWorker(
  mode: string,
  databasePath: string,
  argument?: string
): ChildProcess {
  const worker = fork(
    workerPath,
    [mode, databasePath, ...(argument === undefined ? [] : [argument])],
    {
      cwd: dirname(workerPath),
      execArgv: ['--import', 'tsx'],
      serialization: 'json',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    }
  )
  liveWorkers.add(worker)
  worker.once('exit', () => liveWorkers.delete(worker))
  return worker
}

function nextMessage(worker: ChildProcess): Promise<Record<string, unknown>> {
  return new Promise((resolveMessage, rejectMessage) => {
    let stderr = ''
    const timeout = setTimeout(() => {
      cleanup()
      rejectMessage(new Error('WORKER_MESSAGE_TIMEOUT'))
    }, 5_000)
    const onData = (value: Buffer | string) => {
      stderr += value.toString()
    }
    const onMessage = (value: unknown) => {
      cleanup()
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        rejectMessage(new Error('INVALID_WORKER_MESSAGE'))
        return
      }
      resolveMessage(value as Record<string, unknown>)
    }
    const onError = (error: Error) => {
      cleanup()
      rejectMessage(error)
    }
    const onExit = (code: number | null) => {
      cleanup()
      rejectMessage(new Error(`WORKER_EXIT_${String(code)}:${stderr}`))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      worker.stderr?.off('data', onData)
      worker.off('message', onMessage)
      worker.off('error', onError)
      worker.off('exit', onExit)
    }
    worker.stderr?.on('data', onData)
    worker.once('message', onMessage)
    worker.once('error', onError)
    worker.once('exit', onExit)
  })
}

async function killWorker(worker: ChildProcess): Promise<void> {
  liveWorkers.delete(worker)
  if (worker.exitCode !== null || worker.signalCode !== null) return
  await new Promise<void>(resolveExit => {
    worker.once('exit', () => resolveExit())
    worker.kill('SIGKILL')
  })
}

function productionTypeScriptFiles(root: string): string[] {
  const entries = readDirectory(root)
  return entries.filter(path =>
    /\.(ts|tsx)$/.test(path) &&
    !/\.(test|spec)\.(ts|tsx)$/.test(path) &&
    !path.endsWith('.d.ts')
  )
}

function readDirectory(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name)
    return entry.isDirectory() ? readDirectory(path) : [path]
  })
}
