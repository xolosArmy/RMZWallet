# Tonalli Memo Phase 6-I-C — rollback-defense decision gate

## Status

**REMOTE WITNESS MODEL APPROVED. IMPLEMENTATION GATE A PRESENT. OPERATIONAL
DISPATCH REMAINS DISABLED.**

This decision gate is based on RMZWallet commit
`e5809a0426cdbcf89c352bd46703d7487239bf48`, tree
`bb490d8f3f97f5db6697375fb67da172ba03bfe5`.

Phase 6-I-B correctly protects the internal consistency of the SQLite store,
but it cannot detect restoration of an older, internally valid copy. Phase
6-I-C must not connect transport authority until an independently persisted,
authenticated remote witness outside both the SQLite rollback domain and the
client's normal backup/restore domain is deployed and verified.

This document makes no dispatch path reachable and changes no closed Phase
6-B through Phase 6-H authority source.

## Evidence from the current implementation

The current store keeps all of the following in `tm1.sqlite`:

- publication revisions and owner epochs;
- canonical recovery JSON and its SHA-256 digest;
- physical-schema identity and attestation evidence;
- globally unique consumed-capability evidence;
- dispatch-intent, acknowledgement and observation evidence.

`BEGIN IMMEDIATE`, WAL, `synchronous=FULL`, schema attestation, record digests,
revision CAS and owner-epoch fencing protect transactions and detect malformed
or inconsistent current state. They do not cross the rollback boundary.

If a valid generation N database replaces the active N+2 database, every
value above consistently returns to N. The store cannot distinguish that event
from a process that never advanced past N. A hash or generation added only to
the same database would have the same limitation.

## Threat addressed

The required defense covers this sequence:

1. a valid database exists at generation N;
2. the controller durably advances authority evidence through N+1 and N+2;
3. the process stops;
4. an old valid database copy from N replaces the active SQLite persistence
   unit;
5. the restored schema, records, hashes, revisions, owner epochs and consumed
   capabilities are internally valid;
6. restart must not silently regain authority, reuse a capability or permit a
   transport attempt from the restored state.

The defense is fail-closed. Availability after ambiguous or contradictory
evidence is secondary to preventing duplicate authority.

## Options evaluated

### File beside `tm1.sqlite` — rejected as a security anchor

An atomically replaced local checkpoint file can detect accidental rollback of
only the database. It cannot detect restoration of a directory, filesystem
snapshot, machine image or backup containing both artifacts. File permissions
do not provide monotonicity against an administrator or restore mechanism.

### Append-only journal on the same filesystem — rejected as sufficient

Hash chaining detects edits and truncation only while a later trusted head
survives. Restoring the journal and database together to an older mutually
consistent pair removes that trusted head too.

### Separately protected local file or mount — conditional evidence only

This is useful only if deployment can prove that the checkpoint is outside the
database backup/restore domain and cannot be rolled back with it. A convention
such as a different pathname, directory or Unix account is not that proof.

### Platform-backed secure monotonic storage — deferred, not authoritative

A TPM, secure element or OS facility may be reconsidered only after concrete
availability and semantics are demonstrated. No such facility is currently
selected, pinned or verified by this repository.

### Independent authenticated append-only witness — selected model

An independently persisted witness can keep a monotonic checkpoint outside
the host/filesystem restore domain. It introduces a new availability and trust
dependency and therefore materially changes the architecture. It is acceptable
only with authenticated compare-and-set, append-only history, durable writes,
store/machine namespace binding and explicit failure semantics.

## Decision

Phase 6-I-C uses the **REMOTE_AUTHENTICATED_APPEND_ONLY_WITNESS** trust model
through a narrow external witness contract. The default configuration has no
witness and must deny all authority-bearing durable mutations and all
transport dispatch.

Authority may eventually be enabled only when an independently administered,
authenticated append-only backend provides evidence that survives restoration
of the SQLite persistence unit and the client host backup domain.

The Gate A implementation supplies the protocol, strict parsing, deterministic
logical root, SQLite identity binding, startup/provisioning gate and a
deterministic adversarial-test witness. It does not supply a production remote
endpoint and therefore does not enable authority or dispatch by itself.

A plain local file, same-filesystem journal or value stored in SQLite does not
satisfy the production contract. No production remote backend has yet been
implemented or configured.

If no acceptable backend is deployed, the strongest supported policy is:

- existing evidence may be read and displayed;
- exact-txid observation may run without creating authority;
- authority-bearing durable transitions fail closed;
- signing and transport remain unreachable;
- restoration requires incident handling, never automatic re-baselining.

## Checkpoint model

The versioned witness record binds:

- witness protocol version;
- canonical store ID;
- authenticated client/witness slot ID;
- monotonically increasing database generation;
- canonical logical database root;
- previous stable receipt hash;
- unique operation ID;
- state: `pending` or `stable`;
- witness key/version ID;
- authenticated receipt and its canonical hash.

Timestamps may be retained for diagnostics but are not trusted monotonic
evidence.

The canonical database root covers all authoritative logical state, not only
one publication. Gate A includes:

- root, physical-schema and witness-protocol versions;
- canonical store ID, slot ID, generation and store creation metadata;
- every publication ID, canonical record JSON and record digest in
  deterministic order;
- every complete consumed-capability row in deterministic order.

The root field and physical SQLite representation are excluded from its
digest. The root calculation runs over one attested SQLite transaction
snapshot. WAL/checkpoint layout, page order, `VACUUM` output and SQLite
statistics therefore cannot change it. Selective replacement of an old row
must therefore disagree with the externally anchored root even if that row is
internally valid.

The store ID is identity, not a secret. A non-empty database with no matching
witness namespace must never be silently assigned a new identity.

## Atomicity protocol

SQLite and the witness cannot participate in one native atomic commit. The
approved protocol therefore has three durable stages and treats every
ambiguous window conservatively:

1. **Remote reserve:** authenticate the stable witness head and perform a CAS
   from its exact generation/root/receipt to one `pending` successor containing
   the proposed generation, root and operation identity. Only the controller
   that receives and authenticates this successful reserve response receives a
   process-local reservation grant.
2. **Local commit:** inside `BEGIN IMMEDIATE`, re-attest schema and identity,
   reverify the exact old generation/root, apply exactly the intended mutation,
   verify the proposed logical root and durably commit the new generation/root.
   The exact, one-shot reservation grant is mandatory; an authentic pending
   record observed through `read()` is insufficient.
3. **Remote finalize:** finalize only the exact matching pending record. Only
   the resulting stable witness head can satisfy a later authority gate.

Witness reserve or finalization failures never authorize the caller. No
authority-bearing external side effect may run until the witness is stable. A
timeout is an ambiguous failure and remains fail-closed.

The reservation grant is a runtime bearer capability registered by module-
private provenance state. It binds the slot, store, old stable
generation/root/receipt, next generation/root, operation, pending receipt,
witness key and protocol version. It is never serialized, cached or recreated
from a pending record. A TypeScript lookalike has no authority. If the winner
crashes before local commit, the grant is lost and the old-DB/pending state
remains quarantined. After local commit, matching durable SQLite state plus an
authenticated pending observation may authorize finalize-only recovery without
the lost grant.

Receipt material remains outside the canonical SQLite logical root. All grant
bindings are known before local commit, while the new stable receipt exists
only after finalize. Consequently the fencing mechanism introduces no
root/receipt cycle and finalize does not mutate the just-rooted local state.

## Crash and mismatch matrix

| Boundary | Durable evidence | Restart behavior |
| --- | --- | --- |
| Before witness prepare | DB N, witness stable N | Safe to retry the mutation under fresh CAS/fencing. |
| After prepare, before DB commit | DB N, witness pending N+1 | Quarantine. Do not discard the pending record automatically; this is indistinguishable from DB rollback after commit. |
| DB transaction rolls back after prepare | DB N, witness pending N+1 | Same quarantine; manual evidence is required. |
| After DB commit, before witness finalize | DB N+1 matches pending N+1 root | Finalization may resume without signer or transport execution. |
| After witness finalize, before returning | DB N+1, witness stable N+1 | Load the stable state idempotently; never repeat an external side effect. |
| Witness stable newer than DB | DB older than witness | Rollback detected; fail closed. |
| DB newer than witness with no matching pending | Contradictory state | Fail closed; never advance the witness from database assertion alone. |
| Same generation, different root | Contradictory state | Fail closed as corruption, substitution or replay. |
| Missing or corrupt witness for non-empty DB | No external authority | Fail closed; no automatic witness recreation. |
| Witness unavailable | Identity cannot be verified | No authority transition or dispatch; read-only degraded status only. |
| Both DB and a file witness restored together | Mutually old pair | Undetectable; such a file witness is not an acceptable authority backend. |
| Full host image cloned without independent witness access | Foreign deployment | Fail closed on namespace/binding mismatch or witness absence. |

## Initialization and restore policy

First initialization is allowed only when both sides prove absence: a newly
created empty SQLite store and an unallocated witness namespace. Bootstrap must
create one store ID and initial root through a reviewed protocol. One side
existing without the other is an incident, not a first run.

Backups may be restored for evidence recovery, but restoring an older backup
does not restore authority. An intentional restore enters observation-only
quarantine. It may inspect exact txids and export evidence. It cannot reuse
consumed capabilities, sign, dispatch or automatically create a new witness
head.

Checkpoint corruption or loss has the same policy. Manual re-baselining, if it
is ever supported, must create a new store identity, permanently retire the old
witness namespace and abandon prior pre-dispatch work. It is a separate
security ceremony and is not part of automatic startup.

## Concurrency and ownership

SQLite `ownerEpoch` and revision CAS remain necessary but are not sufficient.
Before authority is enabled, composition also requires:

- one exclusive local-controller lease for the deployment;
- a witness fencing token on every checkpoint transition;
- rejection of stale witness generations and fencing tokens;
- no automatic transport by a recovering or observation-only process.

Two database copies with the same store ID, including a copy opened from a
different path, compete for one witness namespace. At most one fenced mutation
may advance it. A copied database must not obtain a new witness namespace
implicitly.

Winning the remote CAS and merely observing its result are distinct. The CAS
winner alone receives the non-serializable reservation grant needed by the
pre-commit SQLite boundary. A losing controller may authenticate the winner's
pending record for mismatch classification, but cannot convert that observation
into local mutation authority. A matching already-committed database remains
sufficient only for finalize-only crash recovery.

## Dispatch ordering after this gate is satisfied

The eventual controller must preserve:

```text
BROADCAST authorization consumed
  -> externally anchored execution evidence
  -> externally anchored durable dispatchIntent/outcomeUnknown
  -> exactly one transport attempt
  -> externally anchored positive acknowledgement
```

Transport must not run after only the SQLite commit. It may run only after the
matching dispatch-intent checkpoint is stable in the external witness.

A crash after stable dispatch intent but before the transport call still
recovers as `outcomeUnknown` and observation-only. This may sacrifice a
dispatch that never occurred, but it cannot authorize a retry. A crash during
submission or before acknowledgement has the same observation-only behavior.
Chronik absence never permits rebroadcast.

## PREPARED and SIGNED restart semantics

This decision does not reopen Phase 6-I-A semantics. Interrupted pre-dispatch
work is abandoned and requires a new workflow with fresh human approvals.
Pending prompts, capabilities, signer state and private material are not
hydrated. Persisted SIGNED evidence would remain evidence only and would never
imply BROADCAST authority.

## Mandatory fail-closed conditions

Authority remains disabled when any of the following is true:

- no approved external witness backend is configured;
- witness state is missing, corrupt, unavailable, stale or contradictory;
- database generation/root does not exactly match stable or recoverable
  pending witness evidence;
- witness CAS or fencing fails;
- a pending checkpoint cannot be reconciled unambiguously;
- controller ownership is concurrent or uncertain;
- bootstrap or restore history is ambiguous;
- database or witness durability cannot be established.

## Residual trust assumptions and out-of-scope attacks

The model assumes the selected witness truthfully provides durable monotonic
CAS and cannot be restored with `tm1.sqlite`. It does not solve compromise or
collusion of that witness, stolen witness credentials, a malicious platform
firmware/secure element, or an administrator able to roll back every trust
domain together.

There is no purely local software mechanism that can distinguish an
intentional full-filesystem rollback when every local artifact and trusted
reference is restored together. Claiming otherwise would be a fake guarantee.

## Required tests before authority is enabled

Rollback and checkpoint tests must include:

- old internally valid DB with newer stable witness;
- DB newer than stable witness with and without matching pending evidence;
- crash after witness prepare and before SQLite commit;
- crash after SQLite commit and before witness finalize;
- corrupt, missing, replayed and unavailable witness state;
- selective old publication/capability rows under a current generation;
- same DB copied to another path or machine namespace;
- simultaneous controllers and stale witness fencing tokens;
- first-initialization partial failure and ambiguous restore;
- torn/failed witness writes and bounded timeouts.

Dispatch tests must additionally prove:

- transport is unreachable before stable dispatch-intent anchoring;
- crash before or after dispatch-intent commit does not redispatch;
- a never-returning or ambiguous transport stays `outcomeUnknown`;
- restart observes only the exact txid;
- duplicate capability consumption and stale owner/fencing fail closed;
- acknowledgement cannot manufacture or reopen transport authority.

All existing Phase 6-I-A and 6-I-B authority, browser-graph, closed-source and
runtime gates remain mandatory.

## Gate A implementation boundary

Gate A is additive and server-only around the closed store/controller
contracts. It provides:

- a Node-free external-witness port, strict record model and deterministic
  test witness;
- an attested SQLite v2 identity binding and canonical whole-store root;
- explicit provisioning and ordinary-startup freshness gates;
- fail-closed mismatch classification and matching-pending finalization;
- a process-local, runtime-provenance reservation grant that fences the exact
  pre-commit SQLite generation/root advance;
- adversarial and architecture tests.

Still required before operational authority is enabled are a real independent
authenticated witness adapter/service, deployment credential and slot
provisioning, durable append-only/CAS evidence, service availability policy,
and native-environment verification. Dispatch coordination remains a later,
separately reviewed gate.

The browser must receive only narrow application snapshots and commands. It
must not receive the witness, SQLite connection, signer, transport, capability
ledger or mutable controller internals.

No signer, transport, dispatch, rebroadcast, React or mainnet composition is
introduced by Gate A.
