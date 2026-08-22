import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import {
  parseTm1PublicationRecoveryRecord,
  type Tm1PublicationRecoveryRecord
} from '../src/integrations/tonalliMemo/recovery/tm1PublicationRecoveryModel'
import { createTm1SqlitePublicationRecoveryStore } from '../server/tonalliMemo/recovery/tm1SqlitePublicationRecoveryStore'

const [, , mode, databasePath, argument] = process.argv

if (typeof mode !== 'string' || typeof databasePath !== 'string') fail('INVALID_WORKER_INPUT')

try {
  if (mode === 'hold-before-commit') {
    holdBeforeCommit(databasePath)
  } else if (mode === 'create-and-hold') {
    await createAndHold(databasePath, requireArgument(argument))
  } else if (mode === 'load-only') {
    await loadOnly(databasePath, requireArgument(argument))
  } else if (mode === 'stale-recovery') {
    await staleRecovery(databasePath, requireArgument(argument))
  } else {
    fail('INVALID_WORKER_INPUT')
  }
} catch (error) {
  send({ status: 'error', code: errorCode(error) })
  process.exitCode = 1
}

function holdBeforeCommit(path: string): void {
  const database = new DatabaseSync(path, {
    allowExtension: false,
    enableForeignKeyConstraints: true,
    timeout: 1_000
  })
  database.enableLoadExtension(false)
  const row = database.prepare(`
    SELECT created_at
    FROM tm1_store_metadata
    WHERE singleton_id = 1
  `).get()
  const previous = row?.created_at
  if (typeof previous !== 'number') fail('INVALID_METADATA')
  database.exec('BEGIN IMMEDIATE')
  database.prepare(`
    UPDATE tm1_store_metadata
    SET created_at = ?
    WHERE singleton_id = 1
  `).run(previous + 1)
  send({ status: 'before-commit', previous })
  keepAlive()
}

async function createAndHold(path: string, payloadPath: string): Promise<void> {
  const record = parseTm1PublicationRecoveryRecord(
    JSON.parse(readFileSync(payloadPath, 'utf8'))
  )
  const store = createTm1SqlitePublicationRecoveryStore({
    databasePath: path,
    now: () => 1_000
  })
  await store.create({ record })
  send({ status: 'after-commit', publicationId: record.publicationId })
  keepAlive()
}

async function loadOnly(path: string, publicationId: string): Promise<void> {
  const store = createTm1SqlitePublicationRecoveryStore({
    databasePath: path,
    now: () => 1_000
  })
  const record = await store.load(publicationId)
  store.close()
  send({ status: 'loaded', record })
}

async function staleRecovery(path: string, publicationId: string): Promise<void> {
  const store = createTm1SqlitePublicationRecoveryStore({
    databasePath: path,
    now: () => 1_000
  })
  const current = await store.load(publicationId) as Tm1PublicationRecoveryRecord | null
  if (current === null || current.phase !== 'outcomeUnknown' || current.dispatchIntent === null) {
    fail('INVALID_RECOVERY_STATE')
  }
  send({
    status: 'loaded',
    revision: current.revision,
    ownerEpoch: current.ownerEpoch
  })
  process.once('message', async message => {
    if (!message || typeof message !== 'object' || !('command' in message) || message.command !== 'commit') {
      fail('INVALID_WORKER_INPUT')
    }
    try {
      const next = parseTm1PublicationRecoveryRecord({
        ...current,
        revision: current.revision + 1,
        lastObservation: {
          status: 'absent',
          txid: current.dispatchIntent!.txid,
          observedAt: 4_000
        }
      })
      await store.commitRecoveryTransition({
        publicationId: current.publicationId,
        expectedRevision: current.revision,
        expectedOwnerEpoch: current.ownerEpoch,
        nextRecord: next
      })
      send({ status: 'unexpected-success' })
    } catch (error) {
      send({ status: 'rejected', code: errorCode(error) })
    } finally {
      store.close()
    }
  })
  keepAlive()
}

function requireArgument(value: string | undefined): string {
  if (typeof value !== 'string' || value.length === 0) return fail('INVALID_WORKER_INPUT')
  return value
}

function keepAlive(): void {
  setInterval(() => undefined, 1_000)
}

function send(message: Readonly<Record<string, unknown>>): void {
  process.send?.(message)
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  return 'RECOVERY_STORE_FAILED'
}

function fail(code: string): never {
  const error = new Error(code)
  Object.assign(error, { code })
  throw error
}
