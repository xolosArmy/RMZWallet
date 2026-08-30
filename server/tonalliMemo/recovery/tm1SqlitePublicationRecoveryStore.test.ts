import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import type {
  Tm1PublicationRecoveryRecord,
  Tm1TransportAcknowledgementCommitEvidence
} from '../../../src/integrations/tonalliMemo/recovery/tm1PublicationRecoveryModel'
import {
  canonicalizeTm1RecoveryRecord,
  sha256Hex
} from './tm1SqliteSchema'
import { encodeTm1SqliteIdentifierKey } from './tm1SqliteIdentifierKey'
import {
  createTm1SqlitePublicationRecoveryStore,
  type Tm1SqlitePublicationRecoveryStore
} from './tm1SqlitePublicationRecoveryStore'
import {
  HASH_B,
  HASH_C,
  allowLegacyMutationInPhysicalStoreTest,
  absentObservationRecord,
  abandonedRecord,
  broadcastConsumedRecord,
  outcomeUnknownRecord,
  preparedRecord,
  signingConsumedRecord,
  signingPendingRecord
} from './tm1SqliteTestFixtures'

const temporaryDirectories: string[] = []

type PersistedIdentifierField =
  | 'publication_id'
  | 'prepared_id'
  | 'signing_capability_id'
  | 'signing_operation_id'
  | 'signed_id'
  | 'broadcast_capability_id'
  | 'broadcast_operation_id'
  | 'dispatch_submission_id'

const PERSISTED_IDENTIFIER_FIELDS: readonly PersistedIdentifierField[] = Object.freeze([
  'publication_id',
  'prepared_id',
  'signing_capability_id',
  'signing_operation_id',
  'signed_id',
  'broadcast_capability_id',
  'broadcast_operation_id',
  'dispatch_submission_id'
])

const VALID_DOMAIN_IDENTIFIERS = Object.freeze([
  { label: 'a lone high surrogate at the first code unit', value: '\ud800identifier' },
  { label: 'a lone high surrogate in the middle', value: 'identifier:\ud800:value' },
  { label: 'a lone high surrogate at the last code unit', value: 'identifier:\ud800' },
  { label: 'a lone low surrogate', value: 'identifier:\udc00' },
  { label: 'a distinct lone high surrogate', value: 'identifier:\ud801' },
  { label: 'a valid surrogate pair', value: 'identifier:\ud83d\ude00' },
  { label: 'embedded NUL', value: 'identifier\u0000value' },
  { label: 'BMP Unicode', value: 'identifier:ñ:漢' },
  { label: 'a combining sequence', value: 'identifier:e\u0301' },
  {
    label: 'mixed ASCII, BMP, astral and lone-surrogate code units',
    value: 'identifier:ñ:\ud83d\ude00:\ud800:end'
  },
  { label: 'the 256-code-unit ASCII maximum', value: 'a'.repeat(256) },
  {
    label: 'a mixed exact 256-code-unit boundary',
    value: `${'a'.repeat(252)}\ud83d\ude00\ud800ñ`
  }
])

const INVALID_DOMAIN_IDENTIFIERS = Object.freeze([
  { label: 'empty', value: '' },
  { label: 'whitespace-only', value: ' \t ' },
  { label: 'leading whitespace', value: ' identifier' },
  { label: 'trailing whitespace', value: 'identifier ' },
  { label: '257 ASCII code units', value: 'a'.repeat(257) },
  { label: '258 astral code units', value: '\ud83d\ude00'.repeat(129) },
  { label: 'a mixed 257-code-unit boundary', value: `${'a'.repeat(255)}\ud83d\ude00` }
])

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('TM1 Node SQLite recovery store', () => {
  test('encodes physical keys from exact UTF-16 code units', () => {
    expect(encodeTm1SqliteIdentifierKey('A')).toBe('u16:0041')
    expect(encodeTm1SqliteIdentifierKey('\u0000')).toBe('u16:0000')
    expect(encodeTm1SqliteIdentifierKey('\ud83d\ude00')).toBe('u16:d83dde00')
    expect(encodeTm1SqliteIdentifierKey('\ud800')).toBe('u16:d800')
    expect(new Set([
      encodeTm1SqliteIdentifierKey('\ud800'),
      encodeTm1SqliteIdentifierKey('\ud801'),
      encodeTm1SqliteIdentifierKey('\ufffd')
    ]).size).toBe(3)
  })

  test('creates a real WAL/FULL store with the required connection policy', () => {
    const { store } = harness({ busyTimeoutMs: 321 })

    expect(store.inspectDurability()).toEqual({
      sqliteVersion: process.versions.sqlite,
      journalMode: 'wal',
      synchronous: 2,
      foreignKeys: 1,
      trustedSchema: 0,
      busyTimeoutMs: 321
    })
    store.close()
  })

  test('round-trips validated records as defensive frozen snapshots', async () => {
    const { store } = harness()
    const original = preparedRecord()

    const created = await store.create({ record: original }) as Tm1PublicationRecoveryRecord
    const loaded = await store.load(original.publicationId) as Tm1PublicationRecoveryRecord

    expect(loaded).toEqual(original)
    expect(created).toEqual(original)
    expect(Object.isFrozen(loaded)).toBe(true)
    expect(Object.isFrozen(loaded.prepared)).toBe(true)
    expect(await store.load('publication:missing')).toBeNull()
    store.close()
  })

  describe.each(PERSISTED_IDENTIFIER_FIELDS)('%s domain compatibility', field => {
    test.each(VALID_DOMAIN_IDENTIFIERS)(
      'round-trips $label exactly across close and reopen',
      async ({ value }) => {
        const { databasePath } = emptyPath()
        const record = recordWithIdentifier(field, value)
        const first = openStore(databasePath)
        const created = await first.create({ record }) as Tm1PublicationRecoveryRecord

        expect(readIdentifier(created, field)).toBe(value)
        expect(value.length).toBeLessThanOrEqual(256)
        const physicalKeys = readPhysicalIdentifiers(databasePath, field, record)
        expect(physicalKeys.length).toBeGreaterThan(0)
        for (const physicalKey of physicalKeys) {
          expect(physicalKey).toBe(encodeTm1SqliteIdentifierKey(value))
          expect(physicalKey).not.toContain('\ufffd')
        }
        first.close()

        const reopened = openStore(databasePath)
        const loaded = await reopened.load(record.publicationId) as Tm1PublicationRecoveryRecord
        expect(readIdentifier(loaded, field)).toBe(value)
        expect(loaded).toEqual(created)
        reopened.close()
      }
    )

    test.each(INVALID_DOMAIN_IDENTIFIERS)(
      'rejects $label through the closed parser before persistence',
      async ({ value }) => {
        const { store } = harness()
        const record = recordWithIdentifier(field, value)

        await expect(store.create({ record })).rejects.toMatchObject({
          code: field === 'publication_id'
            ? 'INVALID_PUBLICATION_ID'
            : 'MALFORMED_RECOVERY_RECORD'
        })
        await expect(store.listRecoverable()).resolves.toEqual([])
        store.close()
      }
    )
  })

  test('round-trips the exact Codex lone-surrogate publication ID', async () => {
    const { databasePath } = emptyPath()
    const publicationId = 'publication:\ud800'
    const record = preparedRecord({ publicationId })
    const first = openStore(databasePath)
    await expect(first.create({ record })).resolves.toEqual(record)
    expect(readPhysicalIdentifiers(databasePath, 'publication_id', record))
      .toEqual(['u16:007000750062006c00690063006100740069006f006e003ad800'])
    first.close()

    const reopened = openStore(databasePath)
    const loaded = await reopened.load(publicationId) as Tm1PublicationRecoveryRecord
    expect(loaded).toEqual(record)
    expect(loaded.publicationId).toBe(publicationId)
    expect(loaded.publicationId.charCodeAt(loaded.publicationId.length - 1)).toBe(0xd800)
    expect(loaded.publicationId).not.toContain('\ufffd')
    reopened.close()
  })

  test('keeps distinct lone-surrogate publication IDs collision-free', async () => {
    const { store, databasePath } = harness()
    const firstId = 'publication:\ud800'
    const secondId = 'publication:\ud801'
    const first = preparedRecord({ publicationId: firstId })
    const second = preparedRecord({ publicationId: secondId })

    await expect(store.create({ record: first })).resolves.toEqual(first)
    await expect(store.create({ record: second })).resolves.toEqual(second)
    await expect(store.load(firstId)).resolves.toEqual(first)
    await expect(store.load(secondId)).resolves.toEqual(second)
    const listed = await store.listRecoverable() as readonly Tm1PublicationRecoveryRecord[]
    expect(listed.map(record => record.publicationId)).toEqual([firstId, secondId])

    const database = new DatabaseSync(databasePath, { allowExtension: false })
    expect(database.prepare(`
      SELECT publication_id
      FROM tm1_publications
      ORDER BY publication_id
    `).all().map(row => row.publication_id)).toEqual([
      encodeTm1SqliteIdentifierKey(firstId),
      encodeTm1SqliteIdentifierKey(secondId)
    ])
    database.close()
    store.close()
  })

  test('preserves encoded surrogate capability PKs and publication FKs', async () => {
    const { store, databasePath } = harness()
    const first = signingConsumedRecord({
      publicationId: 'publication:first',
      signingCapabilityId: 'capability:\ud800'
    })
    const second = signingConsumedRecord({
      publicationId: 'publication:second',
      signingCapabilityId: 'capability:\ud801'
    })

    await expect(store.create({ record: first })).resolves.toEqual(first)
    await expect(store.create({ record: second })).resolves.toEqual(second)
    await expect(store.load(first.publicationId)).resolves.toEqual(first)
    await expect(store.load(second.publicationId)).resolves.toEqual(second)

    const database = new DatabaseSync(databasePath, { allowExtension: false })
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(database.prepare(`
      SELECT capability_id
      FROM tm1_consumed_capabilities
      ORDER BY capability_id
    `).all().map(row => row.capability_id)).toEqual([
      encodeTm1SqliteIdentifierKey(first.signingAuthorization!.capabilityId),
      encodeTm1SqliteIdentifierKey(second.signingAuthorization!.capabilityId)
    ])
    database.close()
    store.close()
  })

  test('canonical serialization is stable across caller property order', () => {
    const original = outcomeUnknownRecord()
    const reordered: Record<string, unknown> = Object.fromEntries(
      Object.entries(original).reverse()
    )
    reordered.prepared = Object.fromEntries(Object.entries(original.prepared!).reverse())
    reordered.dispatchIntent = Object.fromEntries(
      Object.entries(original.dispatchIntent!).reverse()
    )

    const first = canonicalizeTm1RecoveryRecord(original)
    const second = canonicalizeTm1RecoveryRecord(reordered)

    expect(second.recordJson).toBe(first.recordJson)
    expect(second.recordSha256).toBe(first.recordSha256)
    expect(first.recordJson).toBe(canonicalizeTm1RecoveryRecord(JSON.parse(first.recordJson)).recordJson)
  })

  test('lists only recoverable records in stable publication order', async () => {
    const { store } = harness()
    const later = preparedRecord({ publicationId: 'publication:z' })
    const earlier = outcomeUnknownRecord({
      publicationId: 'publication:a',
      signingCapabilityId: 'capability:sign:a',
      broadcastCapabilityId: 'capability:broadcast:a'
    })
    const terminalBase = preparedRecord({ publicationId: 'publication:terminal' })

    await store.create({ record: later })
    await store.create({ record: abandonedRecord(terminalBase) })
    await store.create({ record: earlier })

    const listed = await store.listRecoverable() as readonly Tm1PublicationRecoveryRecord[]
    expect(listed.map(record => record.publicationId)).toEqual([
      'publication:a',
      'publication:z'
    ])
    expect(Object.isFrozen(listed)).toBe(true)
    store.close()
  })

  test('rejects duplicate publication IDs without replacing the record', async () => {
    const { store } = harness()
    const record = preparedRecord()
    await store.create({ record })

    await expect(store.create({ record })).rejects.toMatchObject({
      code: 'DUPLICATE_PUBLICATION_ID'
    })
    await expect(store.load(record.publicationId)).resolves.toEqual(record)
    store.close()
  })

  test('enforces globally unique consumed SIGN capability IDs', async () => {
    const { store } = harness()
    const first = signingConsumedRecord({ publicationId: 'publication:first' })
    const second = signingConsumedRecord({ publicationId: 'publication:second' })
    await store.create({ record: first })

    await expect(store.create({ record: second })).rejects.toMatchObject({
      code: 'DUPLICATE_CAPABILITY_CONSUMPTION'
    })
    await expect(store.load(second.publicationId)).resolves.toBeNull()
    store.close()
  })

  test('enforces globally unique consumed BROADCAST capability IDs', async () => {
    const { store } = harness()
    const first = broadcastConsumedRecord({
      publicationId: 'publication:first',
      signingCapabilityId: 'capability:sign:first'
    })
    const second = broadcastConsumedRecord({
      publicationId: 'publication:second',
      signingCapabilityId: 'capability:sign:second'
    })
    await store.create({ record: first })

    await expect(store.create({ record: second })).rejects.toMatchObject({
      code: 'DUPLICATE_CAPABILITY_CONSUMPTION'
    })
    await expect(store.load(second.publicationId)).resolves.toBeNull()
    store.close()
  })

  test('atomically commits execution evidence and capability consumption', async () => {
    const { store } = harness()
    const prepared = preparedRecord()
    const pending = signingPendingRecord()
    const consumed = signingConsumedRecord()
    await store.create({ record: prepared })

    await expect(store.commitExecutionEvidence({
      publicationId: prepared.publicationId,
      expectedRevision: prepared.revision,
      expectedOwnerEpoch: prepared.ownerEpoch,
      nextRecord: pending,
      newlyConsumedCapabilityIds: []
    })).resolves.toEqual(pending)
    await expect(store.commitExecutionEvidence({
      publicationId: pending.publicationId,
      expectedRevision: pending.revision,
      expectedOwnerEpoch: pending.ownerEpoch,
      nextRecord: consumed,
      newlyConsumedCapabilityIds: ['capability:sign:one']
    })).resolves.toEqual(consumed)
    store.close()
  })

  test('rolls back when declared capability evidence does not match the record', async () => {
    const { store } = harness()
    const pending = signingPendingRecord()
    const consumed = signingConsumedRecord()
    await store.create({ record: pending })

    await expect(store.commitExecutionEvidence({
      publicationId: pending.publicationId,
      expectedRevision: pending.revision,
      expectedOwnerEpoch: pending.ownerEpoch,
      nextRecord: consumed,
      newlyConsumedCapabilityIds: []
    })).rejects.toMatchObject({ code: 'RECOVERY_STORE_FAILED' })
    await expect(store.load(pending.publicationId)).resolves.toEqual(pending)
    store.close()
  })

  test('rejects stale revision and stale ownerEpoch independently', async () => {
    const { store } = harness()
    const record = preparedRecord({ ownerEpoch: 4 })
    await store.create({ record })

    await expect(store.claimOwnership({
      publicationId: record.publicationId,
      expectedRevision: record.revision + 1,
      expectedOwnerEpoch: record.ownerEpoch,
      nextOwnerEpoch: 5
    })).rejects.toMatchObject({ code: 'REVISION_MISMATCH' })
    await expect(store.claimOwnership({
      publicationId: record.publicationId,
      expectedRevision: record.revision,
      expectedOwnerEpoch: record.ownerEpoch - 1,
      nextOwnerEpoch: 5
    })).rejects.toMatchObject({ code: 'STALE_OWNER_EPOCH' })
    store.close()
  })

  test('claimOwnership atomically advances revision and ownerEpoch', async () => {
    const { store } = harness()
    const record = preparedRecord()
    await store.create({ record })

    const claimed = await store.claimOwnership({
      publicationId: record.publicationId,
      expectedRevision: record.revision,
      expectedOwnerEpoch: record.ownerEpoch,
      nextOwnerEpoch: 7
    }) as Tm1PublicationRecoveryRecord

    expect(claimed.revision).toBe(record.revision + 1)
    expect(claimed.ownerEpoch).toBe(7)
    expect(await store.load(record.publicationId)).toEqual(claimed)
    store.close()
  })

  test('rejects invalid domain transitions without mutation', async () => {
    const { store } = harness()
    const record = preparedRecord()
    const invalid = signingConsumedRecord()
    await store.create({ record })

    await expect(store.commitExecutionEvidence({
      publicationId: record.publicationId,
      expectedRevision: record.revision,
      expectedOwnerEpoch: record.ownerEpoch,
      nextRecord: invalid,
      newlyConsumedCapabilityIds: ['capability:sign:one']
    })).rejects.toMatchObject({ code: 'INVALID_RECOVERY_TRANSITION' })
    await expect(store.load(record.publicationId)).resolves.toEqual(record)
    store.close()
  })

  test('commits dispatch intent atomically and rejects invalid causal time', async () => {
    const { store } = harness()
    const consumed = broadcastConsumedRecord()
    const valid = outcomeUnknownRecord()
    const invalid = {
      ...valid,
      dispatchIntent: {
        ...valid.dispatchIntent!,
        committedAt: consumed.broadcastAuthorization!.consumedAt - 1
      }
    } as Tm1PublicationRecoveryRecord
    await store.create({ record: consumed })

    await expect(store.commitDispatchIntent({
      publicationId: consumed.publicationId,
      expectedRevision: consumed.revision,
      expectedOwnerEpoch: consumed.ownerEpoch,
      nextRecord: invalid
    })).rejects.toMatchObject({ code: 'MALFORMED_RECOVERY_RECORD' })
    await expect(store.load(consumed.publicationId)).resolves.toEqual(consumed)
    await expect(store.commitDispatchIntent({
      publicationId: consumed.publicationId,
      expectedRevision: consumed.revision,
      expectedOwnerEpoch: consumed.ownerEpoch,
      nextRecord: valid
    })).resolves.toEqual(valid)
    store.close()
  })

  test('commits only an exact positive acknowledgement after dispatch', async () => {
    const { store } = harness()
    const current = outcomeUnknownRecord()
    await store.create({ record: current })
    const acknowledgement = {
      submissionId: current.dispatchIntent!.submissionId,
      signedId: current.signed!.signedId,
      txid: HASH_B,
      signedArtifactHash: HASH_C,
      disposition: 'accepted' as const,
      acknowledgedAt: current.dispatchIntent!.committedAt
    }

    await expect(store.commitTransportAcknowledgement({
      publicationId: current.publicationId,
      expectedRevision: current.revision,
      expectedOwnerEpoch: current.ownerEpoch,
      acknowledgement: { ...acknowledgement, signedId: 'signed:wrong' }
    })).rejects.toMatchObject({ code: 'INVALID_RECOVERY_TRANSITION' })
    await expect(store.load(current.publicationId)).resolves.toEqual(current)

    const committed = await store.commitTransportAcknowledgement({
      publicationId: current.publicationId,
      expectedRevision: current.revision,
      expectedOwnerEpoch: current.ownerEpoch,
      acknowledgement
    }) as Tm1PublicationRecoveryRecord
    expect(committed.phase).toBe('submittedObserved')
    expect(committed.transportAcknowledgement).toEqual({
      txid: HASH_B,
      disposition: 'accepted',
      acknowledgedAt: current.dispatchIntent!.committedAt
    })
    store.close()
  })

  test('rejects acknowledgement time before dispatch without mutation', async () => {
    const { store } = harness()
    const current = outcomeUnknownRecord()
    await store.create({ record: current })

    await expect(store.commitTransportAcknowledgement({
      publicationId: current.publicationId,
      expectedRevision: current.revision,
      expectedOwnerEpoch: current.ownerEpoch,
      acknowledgement: {
        submissionId: current.dispatchIntent!.submissionId,
        signedId: current.signed!.signedId,
        txid: HASH_B,
        signedArtifactHash: HASH_C,
        disposition: 'accepted',
        acknowledgedAt: current.dispatchIntent!.committedAt - 1
      }
    })).rejects.toMatchObject({ code: 'INVALID_RECOVERY_TRANSITION' })
    await expect(store.load(current.publicationId)).resolves.toEqual(current)
    store.close()
  })

  test.each(['txid', 'acknowledgedAt'] as const)(
    'rejects an enumerable %s accessor without invoking it or opening a transaction',
    async field => {
      const { store } = harness()
      const current = outcomeUnknownRecord()
      const acknowledgement = acknowledgementFor(current) as Record<string, unknown>
      let getterCalls = 0
      Object.defineProperty(acknowledgement, field, {
        enumerable: true,
        get: () => {
          getterCalls += 1
          return field === 'txid' ? HASH_B : current.dispatchIntent!.committedAt
        }
      })
      await store.create({ record: current })

      await expect(store.commitTransportAcknowledgement({
        publicationId: current.publicationId,
        expectedRevision: current.revision,
        expectedOwnerEpoch: current.ownerEpoch,
        acknowledgement: acknowledgement as Tm1TransportAcknowledgementCommitEvidence
      })).rejects.toMatchObject({ code: 'MALFORMED_RECOVERY_RECORD' })
      expect(getterCalls).toBe(0)
      expect(readStoreDatabase(store).isTransaction).toBe(false)
      await expect(store.load(current.publicationId)).resolves.toEqual(current)
      store.close()
    }
  )

  test('rejects a non-enumerable forbidden authority field before snapshotting', async () => {
    const { store } = harness()
    const current = outcomeUnknownRecord()
    const acknowledgement = acknowledgementFor(current) as Record<string, unknown>
    Object.defineProperty(acknowledgement, 'transport', {
      enumerable: false,
      value: Object.freeze({ broadcast: true })
    })
    await store.create({ record: current })

    await expect(store.commitTransportAcknowledgement({
      publicationId: current.publicationId,
      expectedRevision: current.revision,
      expectedOwnerEpoch: current.ownerEpoch,
      acknowledgement: acknowledgement as Tm1TransportAcknowledgementCommitEvidence
    })).rejects.toMatchObject({ code: 'FORBIDDEN_AUTHORITY_FIELD' })
    expect(readStoreDatabase(store).isTransaction).toBe(false)
    await expect(store.load(current.publicationId)).resolves.toEqual(current)
    store.close()
  })

  test('rejects symbol-keyed acknowledgement evidence without mutation', async () => {
    const { store } = harness()
    const current = outcomeUnknownRecord()
    const acknowledgement = acknowledgementFor(current) as Record<PropertyKey, unknown>
    acknowledgement[Symbol('hostile')] = true
    await store.create({ record: current })

    await expect(store.commitTransportAcknowledgement({
      publicationId: current.publicationId,
      expectedRevision: current.revision,
      expectedOwnerEpoch: current.ownerEpoch,
      acknowledgement: acknowledgement as Tm1TransportAcknowledgementCommitEvidence
    })).rejects.toMatchObject({ code: 'MALFORMED_RECOVERY_RECORD' })
    expect(readStoreDatabase(store).isTransaction).toBe(false)
    await expect(store.load(current.publicationId)).resolves.toEqual(current)
    store.close()
  })

  test('rejects acknowledgement evidence with a custom prototype without mutation', async () => {
    const { store } = harness()
    const current = outcomeUnknownRecord()
    const acknowledgement = Object.assign(
      Object.create(Object.freeze({ inheritedAuthority: true })),
      acknowledgementFor(current)
    ) as Tm1TransportAcknowledgementCommitEvidence
    await store.create({ record: current })

    await expect(store.commitTransportAcknowledgement({
      publicationId: current.publicationId,
      expectedRevision: current.revision,
      expectedOwnerEpoch: current.ownerEpoch,
      acknowledgement
    })).rejects.toMatchObject({ code: 'MALFORMED_RECOVERY_RECORD' })
    expect(readStoreDatabase(store).isTransaction).toBe(false)
    await expect(store.load(current.publicationId)).resolves.toEqual(current)
    store.close()
  })

  test('accepts null-prototype acknowledgement evidence through the closed parser', async () => {
    const { store } = harness()
    const current = outcomeUnknownRecord()
    const acknowledgement = Object.assign(
      Object.create(null),
      acknowledgementFor(current)
    ) as Tm1TransportAcknowledgementCommitEvidence
    await store.create({ record: current })

    const committed = await store.commitTransportAcknowledgement({
      publicationId: current.publicationId,
      expectedRevision: current.revision,
      expectedOwnerEpoch: current.ownerEpoch,
      acknowledgement
    }) as Tm1PublicationRecoveryRecord
    expect(committed.phase).toBe('submittedObserved')
    expect(Object.isFrozen(committed)).toBe(true)
    expect(Object.isFrozen(committed.transportAcknowledgement)).toBe(true)
    store.close()
  })

  test('persists a canonical acknowledgement exactly across close and reopen', async () => {
    const { store, databasePath } = harness()
    const current = outcomeUnknownRecord()
    await store.create({ record: current })

    const committed = await store.commitTransportAcknowledgement({
      publicationId: current.publicationId,
      expectedRevision: current.revision,
      expectedOwnerEpoch: current.ownerEpoch,
      acknowledgement: acknowledgementFor(current)
    }) as Tm1PublicationRecoveryRecord
    store.close()

    const reopened = openStore(databasePath)
    await expect(reopened.load(current.publicationId)).resolves.toEqual(committed)
    reopened.close()
  })

  test('persists observation-only recovery transitions', async () => {
    const { store } = harness()
    const current = outcomeUnknownRecord()
    const observed = absentObservationRecord(current)
    await store.create({ record: current })

    await expect(store.commitRecoveryTransition({
      publicationId: current.publicationId,
      expectedRevision: current.revision,
      expectedOwnerEpoch: current.ownerEpoch,
      nextRecord: observed
    })).resolves.toEqual(observed)
    await expect(store.load(current.publicationId)).resolves.toEqual(observed)
    store.close()
  })

  test('fails closed on digest mismatch', async () => {
    const { store, databasePath } = harness()
    const record = preparedRecord()
    await store.create({ record })
    store.close()
    mutate(databasePath, 'UPDATE tm1_publications SET record_sha256 = ?', '0'.repeat(64))

    const reopened = openStore(databasePath)
    await expect(reopened.load(record.publicationId)).rejects.toMatchObject({
      code: 'RECOVERY_STORE_FAILED'
    })
    reopened.close()
  })

  test('fails closed on a valid-but-wrong encoded mirror key', async () => {
    const { store, databasePath } = harness()
    const record = preparedRecord()
    await store.create({ record })
    store.close()
    mutate(
      databasePath,
      'UPDATE tm1_publications SET prepared_id = ?',
      encodeTm1SqliteIdentifierKey('prepared:hostile')
    )

    const reopened = openStore(databasePath)
    await expect(reopened.load(record.publicationId)).rejects.toMatchObject({
      code: 'RECOVERY_STORE_FAILED'
    })
    reopened.close()
  })

  test.each([
    'bad:0000',
    'u16:000g',
    'u16:000'
  ])('fails closed on malformed physical identifier key %s', async malformedKey => {
    const { store, databasePath } = harness()
    const record = preparedRecord()
    await store.create({ record })
    store.close()
    mutateIgnoringChecks(
      databasePath,
      'UPDATE tm1_publications SET prepared_id = ?',
      malformedKey
    )

    const reopened = openStore(databasePath)
    await expect(reopened.load(record.publicationId)).rejects.toMatchObject({
      code: 'RECOVERY_STORE_FAILED'
    })
    reopened.close()
  })

  test('listRecoverable validates rows before trusting their mirrored phase', async () => {
    const { store, databasePath } = harness()
    const record = preparedRecord()
    await store.create({ record })
    store.close()
    mutate(databasePath, 'UPDATE tm1_publications SET phase = ?', 'abandoned')

    const reopened = openStore(databasePath)
    await expect(reopened.listRecoverable()).rejects.toMatchObject({
      code: 'RECOVERY_STORE_FAILED'
    })
    reopened.close()
  })

  test('fails closed when capability ledger evidence is missing', async () => {
    const { store, databasePath } = harness()
    const record = signingConsumedRecord()
    await store.create({ record })
    store.close()
    mutate(
      databasePath,
      'DELETE FROM tm1_consumed_capabilities WHERE capability_id = ?',
      encodeTm1SqliteIdentifierKey(record.signingAuthorization!.capabilityId)
    )

    const reopened = openStore(databasePath)
    await expect(reopened.load(record.publicationId)).rejects.toMatchObject({
      code: 'RECOVERY_STORE_FAILED'
    })
    reopened.close()
  })

  test('fails closed on malformed canonical record JSON', async () => {
    const { store, databasePath } = harness()
    const record = preparedRecord()
    await store.create({ record })
    store.close()
    const malformed = '{'
    mutate(
      databasePath,
      'UPDATE tm1_publications SET record_json = ?, record_sha256 = ?',
      malformed,
      sha256Hex(malformed)
    )

    const reopened = openStore(databasePath)
    await expect(reopened.load(record.publicationId)).rejects.toMatchObject({
      code: 'RECOVERY_STORE_FAILED'
    })
    reopened.close()
  })

  test('fails closed when out-of-band state contains a domain-invalid operation ID', async () => {
    const { store, databasePath } = harness()
    const record = signingConsumedRecord()
    const canonical = canonicalizeTm1RecoveryRecord(record)
    await store.create({ record })
    store.close()

    const decoded = JSON.parse(canonical.recordJson) as Record<string, unknown>
    const signingAuthorization = decoded.signingAuthorization as Record<string, unknown>
    const invalidOperationId = 'a'.repeat(257)
    signingAuthorization.operationId = invalidOperationId
    const hostileRecordJson = JSON.stringify(decoded)
    mutate(
      databasePath,
      'UPDATE tm1_publications SET record_json = ?, record_sha256 = ?',
      hostileRecordJson,
      sha256Hex(hostileRecordJson)
    )
    mutateIgnoringChecks(
      databasePath,
      'UPDATE tm1_consumed_capabilities SET operation_id = ?',
      invalidOperationId
    )

    const reopened = openStore(databasePath)
    await expect(reopened.load(record.publicationId)).rejects.toMatchObject({
      code: 'MALFORMED_RECOVERY_RECORD'
    })
    reopened.close()
  })

  test('fails closed on unsupported physical schema versions', () => {
    const { databasePath } = emptyPath()
    const database = new DatabaseSync(databasePath, { allowExtension: false })
    database.exec('PRAGMA user_version = 2')
    database.close()
    if (process.platform !== 'win32') chmodSync(databasePath, 0o600)

    let thrown: unknown
    try {
      openStore(databasePath)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toMatchObject({ code: 'RECOVERY_STORE_FAILED' })
  })
})

function harness(
  options: Readonly<{ busyTimeoutMs?: number }> = {}
): Readonly<{
  store: Tm1SqlitePublicationRecoveryStore
  databasePath: string
}> {
  const { databasePath } = emptyPath()
  return Object.freeze({
    databasePath,
    store: openStore(databasePath, options.busyTimeoutMs)
  })
}

function emptyPath(): Readonly<{ directory: string; databasePath: string }> {
  const directory = mkdtempSync(join(tmpdir(), 'rmz-tm1-sqlite-'))
  temporaryDirectories.push(directory)
  return Object.freeze({ directory, databasePath: join(directory, 'recovery.db') })
}

function openStore(
  databasePath: string,
  busyTimeoutMs?: number
): Tm1SqlitePublicationRecoveryStore {
  const store = createTm1SqlitePublicationRecoveryStore({
    databasePath,
    ...(busyTimeoutMs === undefined ? {} : { busyTimeoutMs }),
    now: () => 1_000
  })
  allowLegacyMutationInPhysicalStoreTest(store)
  return store
}

function acknowledgementFor(
  current: Tm1PublicationRecoveryRecord
): Tm1TransportAcknowledgementCommitEvidence {
  return {
    submissionId: current.dispatchIntent!.submissionId,
    signedId: current.signed!.signedId,
    txid: HASH_B,
    signedArtifactHash: HASH_C,
    disposition: 'accepted',
    acknowledgedAt: current.dispatchIntent!.committedAt
  }
}

function readStoreDatabase(store: Tm1SqlitePublicationRecoveryStore): DatabaseSync {
  return (store as unknown as { database: DatabaseSync }).database
}

function mutate(databasePath: string, sql: string, ...values: string[]): void {
  const database = new DatabaseSync(databasePath, { allowExtension: false })
  database.prepare(sql).run(...values)
  database.close()
}

function mutateIgnoringChecks(
  databasePath: string,
  sql: string,
  ...values: string[]
): void {
  const database = new DatabaseSync(databasePath, { allowExtension: false })
  database.exec('PRAGMA ignore_check_constraints = ON')
  database.prepare(sql).run(...values)
  database.close()
}

function recordWithIdentifier(
  field: PersistedIdentifierField,
  value: string
): Tm1PublicationRecoveryRecord {
  const record = outcomeUnknownRecord()
  return {
    ...record,
    ...(field === 'publication_id' ? { publicationId: value } : {}),
    prepared: {
      ...record.prepared!,
      ...(field === 'prepared_id' ? { preparedId: value } : {})
    },
    signed: {
      ...record.signed!,
      ...(field === 'signed_id' ? { signedId: value } : {})
    },
    signingAuthorization: {
      ...record.signingAuthorization!,
      ...(field === 'signing_capability_id' ? { capabilityId: value } : {}),
      ...(field === 'signing_operation_id' ? { operationId: value } : {}),
      ...(field === 'prepared_id' ? { preparedId: value } : {})
    },
    broadcastAuthorization: {
      ...record.broadcastAuthorization!,
      ...(field === 'broadcast_capability_id' ? { capabilityId: value } : {}),
      ...(field === 'broadcast_operation_id' ? { operationId: value } : {}),
      ...(field === 'signed_id' ? { signedId: value } : {})
    },
    dispatchIntent: {
      ...record.dispatchIntent!,
      ...(field === 'broadcast_capability_id'
        ? { broadcastCapabilityId: value }
        : {}),
      ...(field === 'dispatch_submission_id' ? { submissionId: value } : {})
    }
  } as Tm1PublicationRecoveryRecord
}

function readIdentifier(
  record: Tm1PublicationRecoveryRecord,
  field: PersistedIdentifierField
): string {
  switch (field) {
    case 'publication_id': return record.publicationId
    case 'prepared_id': return record.prepared!.preparedId
    case 'signing_capability_id': return record.signingAuthorization!.capabilityId
    case 'signing_operation_id': return record.signingAuthorization!.operationId
    case 'signed_id': return record.signed!.signedId
    case 'broadcast_capability_id': return record.broadcastAuthorization!.capabilityId
    case 'broadcast_operation_id': return record.broadcastAuthorization!.operationId
    case 'dispatch_submission_id': return record.dispatchIntent!.submissionId
  }
}

function readPhysicalIdentifiers(
  databasePath: string,
  field: PersistedIdentifierField,
  record: Tm1PublicationRecoveryRecord
): string[] {
  const database = new DatabaseSync(databasePath, { allowExtension: false })
  const publicationKey = encodeTm1SqliteIdentifierKey(record.publicationId)
  const publication = database.prepare(`
    SELECT publication_id, prepared_id, signed_id,
      dispatch_submission_id, dispatch_capability_id
    FROM tm1_publications
    WHERE publication_id = ?
  `).get(publicationKey)
  const capabilities = database.prepare(`
    SELECT kind, capability_id, publication_id, operation_id, prepared_id, signed_id
    FROM tm1_consumed_capabilities
    WHERE publication_id = ?
    ORDER BY kind
  `).all(publicationKey)
  database.close()
  if (publication === undefined) throw new Error('MISSING_PHYSICAL_PUBLICATION')
  const signing = capabilities.find(row => row.kind === 'SIGN')
  const broadcast = capabilities.find(row => row.kind === 'BROADCAST')

  switch (field) {
    case 'publication_id':
      return [
        requireTestString(publication.publication_id),
        ...capabilities.map(row => requireTestString(row.publication_id))
      ]
    case 'prepared_id':
      return [
        requireTestString(publication.prepared_id),
        requireTestString(signing?.prepared_id)
      ]
    case 'signing_capability_id':
      return [requireTestString(signing?.capability_id)]
    case 'signing_operation_id':
      return [requireTestString(signing?.operation_id)]
    case 'signed_id':
      return [
        requireTestString(publication.signed_id),
        requireTestString(broadcast?.signed_id)
      ]
    case 'broadcast_capability_id':
      return [
        requireTestString(publication.dispatch_capability_id),
        requireTestString(broadcast?.capability_id)
      ]
    case 'broadcast_operation_id':
      return [requireTestString(broadcast?.operation_id)]
    case 'dispatch_submission_id':
      return [requireTestString(publication.dispatch_submission_id)]
  }
}

function requireTestString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('MISSING_PHYSICAL_IDENTIFIER')
  return value
}
