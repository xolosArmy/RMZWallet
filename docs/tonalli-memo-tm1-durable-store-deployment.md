# Tonalli Memo Phase 6-I-B — Local Node SQLite recovery store

Phase 6-I-B adds a physical implementation of the closed
`Tm1PublicationRecoveryStore` contract for a future persistent Local Node
Controller. RMZWallet remains a React/Vite/PWA client. Browser code does not
open this database and the adapter is not exported through a client barrel.

This phase implements storage only. It does not create a daemon, loopback API,
React integration, signer, transport, broadcast/rebroadcast route or runtime
composition.

## Runtime boundary

The selected deployment boundary is:

```text
React/Vite/PWA
  -> future authenticated application API
  -> future persistent Local Node Controller
  -> Tm1PublicationRecoveryStore
  -> local SQLite file
```

The implementation uses the built-in `node:sqlite` module and adds no SQLite
package. The verified development runtime for this phase was Node 24.19.0 with
SQLite 3.53.3. A production controller must pin and verify its Node runtime; the
browser bundle cannot import `node:sqlite`.

The database path is mandatory, absolute and explicit. There is no repository,
public-asset, `/tmp`, NFS or cloud-sync default. Production composition must
select a local, non-synchronized filesystem directory controlled by the
controller account. On POSIX the adapter requires a private directory and a
readable/writable owner-only database file. Tests use isolated temporary
directories only.

## Durability policy

Every connection configures and verifies:

- `journal_mode=WAL`;
- `synchronous=FULL`;
- `foreign_keys=ON`;
- `trusted_schema=OFF`;
- a bounded `busy_timeout` (5000 ms by default, maximum 60000 ms);
- extension loading disabled at construction and after open.

Authoritative writes use `BEGIN IMMEDIATE`. Success is returned only after
`COMMIT` succeeds. A failed operation attempts rollback while the connection
still owns a transaction and then fails closed.

WAL alone is not a power-loss guarantee. `synchronous=FULL` asks SQLite to sync
the WAL at commit, but durability still depends on truthful flush behavior from
the Node SQLite build, SQLite VFS, operating system, filesystem and storage
hardware. WAL databases must remain on one host. The database, `-wal` and
`-shm` files are one persistence unit; a live database must be backed up through
SQLite's backup/checkpoint mechanisms, never by copying only the main file.

## Physical schema v1

The SQLite physical schema has its own version and application ID. It is not
`TM1_PUBLICATION_RECOVERY_SCHEMA_VERSION`:

- domain schema version: meaning and validation of the recovery record;
- physical schema version: SQLite tables, indexes and constraints.

A new empty database becomes physical schema v1 in a transaction. A populated
version-zero database, wrong application ID, unknown/newer version or malformed
v1 schema fails closed. Phase 6-I-B contains no legacy migration and performs no
downgrade.

The physical tables are:

### `tm1_store_metadata`

Stores the singleton physical schema version and technical creation time.

### `tm1_publications`

Stores canonical `record_json`, its SHA-256 digest and mirrored authority/query
fields:

- `publication_id`, domain schema/version, `revision`, `owner_epoch`, `phase`;
- `prepared_id`, `binding_hash`;
- `signed_id`, `txid`, `signed_artifact_hash`;
- BROADCAST `consumed_at`;
- dispatch submission/capability IDs and `committed_at`;
- accepted acknowledgement txid and `acknowledged_at`.

Checks enforce all-or-none mirror groups and, where applicable:

```text
BROADCAST consumedAt
  <= dispatchIntent committedAt
  <= accepted acknowledgement acknowledgedAt
```

This is causal ordering, not a trusted wall-clock claim.

### `tm1_consumed_capabilities`

Stores evidence only, never bearer capability objects. `capability_id` is the
global primary key. Each row records kind, operation/content identity,
consumption/expiry time and the exact SIGN or BROADCAST binding. Constraints
require `consumed_at < expires_at` and one consumed capability of each kind per
publication under the current domain model.

Publication changes and newly consumed capability rows commit in the same
transaction. A duplicate capability fails the whole operation.

## Canonical serialization and load validation

The closed Phase 6-I-A parser validates a record before persistence. The
physical encoding then uses this fixed rule:

- object keys sorted lexicographically;
- array order preserved;
- JSON string/boolean/null encoding;
- safe-integer number encoding;
- no insignificant whitespace.

Write path:

```text
closed domain validation
  -> canonical serialization
  -> SHA-256
  -> record JSON + digest + mirrors + capability evidence
```

Load path:

```text
physical schema verification
  -> SHA-256 verification
  -> JSON parse
  -> canonical re-encoding equality
  -> closed domain parse
  -> mirror equality
  -> exact capability-ledger equality
  -> frozen defensive snapshot
```

The digest detects accidental corruption only. It does not resist a local
attacker able to rewrite both record and digest.

## Atomic store operations

All eight closed contract operations are implemented:

- `load` and `listRecoverable` revalidate the persistence boundary;
- `create` atomically reserves any consumed capabilities;
- `commitExecutionEvidence` checks the exact newly consumed ID list;
- `commitDispatchIntent` durably records the exact `outcomeUnknown` intent;
- `commitTransportAcknowledgement` accepts only exact positive returned
  evidence and invokes no transport;
- `commitRecoveryTransition` remains observation/abandonment-only;
- `claimOwnership` atomically advances revision and owner epoch.

Mutations load the current validated snapshot under `BEGIN IMMEDIATE`, check
expected revision and owner epoch, invoke the closed transition validator,
reserve new capability IDs, update with:

```sql
WHERE publication_id = ? AND revision = ? AND owner_epoch = ?
```

and require exactly one changed row before commit.

`ownerEpoch` fences future durable commits by stale processes. It cannot cancel
or reverse a network side effect already started by an older process. Process
ownership and daemon lifecycle remain future composition responsibilities.

SQLite busy, full, I/O, corrupt, not-a-database, read-only, constraint and
commit/sync failures are normalized into the existing recovery-store taxonomy.
Filesystem paths and native error messages do not cross the adapter boundary.
Authority data is never automatically repaired.

## Dispatch-barrier limitation

`commitDispatchIntent()` returning successfully means only that the exact
`outcomeUnknown` dispatch evidence is physically committed. Phase 6-I-B makes
zero network calls.

The closed runtime does not yet await this commit between consumption of the
BROADCAST authorization and its single transport call. Phase 6-I-C must wire
that barrier explicitly. Until then this phase does **not** establish
end-to-end crash-safe TM1 publication.

If a later transport response is unavailable, malformed or cannot be durably
acknowledged, recovery remains observation-only for the exact txid. Chronik
absence is not proof of non-submission and never authorizes retry or
rebroadcast.

## Mandatory rollback-restore decision

**PHASE 6-I-B DOES NOT DETECT RESTORATION OF AN OLD VALID DATABASE COPY.**

A digest stored inside the same database cannot detect rollback of the entire
database. Before Phase 6-I-C makes the durable dispatch path operational, the
architecture must choose an external monotonic anchor, tamper-evident
checkpoint or explicit fail-closed recovery policy. Phase 6-I-B implements none
of these mechanisms.

## Claims and limitations

Phase 6-I-B may claim that the physical adapter durably preserves recovery
records, revision CAS, owner-epoch fencing, globally unique capability
consumption, dispatch-intent evidence, accepted transport-acknowledgement
evidence and recovery observations under the documented SQLite/host durability
assumptions.

It does not claim:

- end-to-end crash-safe publication;
- a wired durable dispatch barrier;
- daemon/service lifecycle;
- loopback authentication;
- React integration;
- exact PREPARED/SIGNED restart hydration;
- detection of old valid database restoration;
- mainnet readiness.
