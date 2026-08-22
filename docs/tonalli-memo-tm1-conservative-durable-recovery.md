# Tonalli Memo Phase 6-I-A — Conservative Durable Recovery

## Status and decision

Phase 6-I-A defines a **Conservative Durable Recovery** contract outside the
closed Phase 6-B through Phase 6-H authority path. It deliberately does not
implement exact workflow resumption.

The adopted policy is:

- interrupted pre-dispatch execution becomes `ABANDONED`;
- continuing publication requires a new workflow and fresh human approvals;
- pending prompts, provider promises, signals and capabilities never survive
  restart;
- consumed authorization is durable evidence, never reusable authority;
- after dispatch may have begun, the attempt remains observation-only;
- recovery never invokes a signer or transport;
- absence from Chronik does not prove non-submission;
- No automatic rebroadcast is permitted.

This phase adds contracts, validation, monotonic state semantics, a narrow
read-only observation boundary and a recovery controller. It does not select a
database, wire a durable store into the live runtime, add React integration or
claim production/mainnet readiness.

## Conservative lifecycle

The versioned recovery model separates:

```text
preDispatch
  -> abandoned

broadcastAuthorizationConsumed
  -> atomic durable dispatchIntent/outcomeUnknown
  -> positive transport acknowledgement OR positive Chronik observation
  -> submittedObserved
  -> confirmedObserved
```

`outcomeUnknown` can remain unknown or advance only through positive evidence:
an accepted result returned by the already-executed single transport call, or
a read-only Chronik observation. It cannot transition back to `preDispatch`,
cannot produce a new authorization and cannot enter a transport-capable state.

An `absent` observation keeps the phase unknown. Chronik unavailability or a
malformed response does not modify the durable record. A mempool observation
advances to `submittedObserved`; an exact positive block observation advances
to `confirmedObserved`. A later absent read cannot regress a previously
submitted observation into authority to retransmit.

`submittedObserved` therefore means that submission is positively evidenced,
not necessarily that Chronik was the evidence source. A durable
`transportAcknowledgement` identifies an accepted response from the exact
dispatch intent; `lastObservation` identifies read-only Chronik evidence.

## Durable evidence, not durable authority

The model may retain the following public evidence:

- version, publication ID, revision and owner epoch;
- prepared ID, exact binding hash and prepared-evidence digest;
- signed ID, transaction ID and signed-artifact hash;
- consumed SIGN evidence bound to `preparedId + bindingHash`;
- consumed BROADCAST evidence bound to
  `signedId + txid + signedArtifactHash`;
- submission ID and committed dispatch intent;
- transport acknowledgement, if already known;
- mempool and confirmation observations;
- abandoned, rejected, expired or failed terminal evidence.

Authorization IDs are capability-consumption evidence. They are not
serializable bearer permissions. A concrete store must reject duplicate
capability consumption globally. Rejected and expired states remain terminal.

The recovery schema rejects authority-bearing fields such as WIF/private-key
material, signer or transport handles, live authorization capabilities,
provider promises, `AbortSignal`, Chronik clients and runtime objects. Data is
validated, defensively cloned and frozen when it crosses the store or observer
boundary.

## Dispatch barrier contract

The required safety ordering is:

```text
validated exact artifact
  -> exact BROADCAST human authorization consumed
  -> durable dispatchIntent/outcomeUnknown committed
  -> existing closed transport may be called
  -> accepted return is durably committed as transportAcknowledgement
```

`Tm1PublicationRecoveryStore.commitDispatchIntent()` represents the dedicated
atomic persistence operation. General recovery updates cannot add or change a
dispatch intent. After that commit, the existing single transport may execute.
If it returns the exact positive accepted result,
`commitTransportAcknowledgement()` may persist that result and advance the
record to `submittedObserved`. The acknowledgement operation checks the same
`submissionId + signedId + txid + signedArtifactHash`, uses revision CAS and
owner-epoch fencing, and grants no transport authority. Repeated
acknowledgements are rejected deterministically rather than treated as another
dispatch.

If the transport throws, the process dies, its response is malformed or the
acknowledgement cannot be durably committed, the attempt remains
`outcomeUnknown` and observation-only. Neither absence nor ambiguity permits a
retry or rebroadcast. Recovery only observes the exact txid.

Phase 6-I-A does **not** splice a second transport path around the closed
runtime. The current orchestrator/runtime has no awaited persistence hook at
the exact pre-dispatch boundary. Therefore actual durable barrier enforcement
is deferred to a later explicitly authorized integration phase. A crash-safe
claim cannot be made merely by defining this contract.

## Store requirements for Phase 6-I-B

No SQLite, IndexedDB or other persistence dependency is chosen here. The
deployment boundary must be decided first. Any concrete store must provide:

- transactional and crash-consistent writes;
- schema-version rejection and corruption detection;
- globally unique publication IDs;
- globally unique consumed capability IDs;
- revision compare-and-swap;
- owner-epoch fencing and atomic takeover;
- monotonic transition enforcement;
- atomic dispatch-intent persistence;
- a dedicated CAS for exact, positive transport acknowledgement recording;
- durable confirmation recording;
- failure after partial or malformed writes without returning fabricated
  authority.

The contract separates execution-evidence, dispatch-intent and recovery
commits so an implementation cannot safely treat them as interchangeable.
The test-only in-memory store used by unit tests is not durable and is not a
runtime implementation.

## Concurrency

Every mutating command carries `expectedRevision` and `expectedOwnerEpoch`.
Stale revisions and stale owner epochs fail closed. Ownership takeover must
advance the epoch atomically so an older process cannot commit afterward.
Concurrent reconciliation can perform duplicate reads, but only one CAS write
may win. Recovery operations never create signing or transmission authority.

## Application boundary for later UI

The future React application must consume the narrow
`Tm1PublicationApplicationPort`, not own `createTm1RegtestRuntime()`, the store
or mutable runtime state. Phase 6-I-A exposes only:

- get a publication snapshot;
- list recoverable snapshots;
- abandon interrupted pre-dispatch work;
- reconcile an unknown outcome;
- observe confirmation of a submitted transaction.

There is intentionally no signer, broadcast, approval-capability or runtime
method on this port. Live start/SIGN/BROADCAST application commands remain a
future contract/integration problem.

## Deferred work and limitations

- Exact PREPARED/SIGNED hydration is deferred.
- A concrete durable store is deferred.
- The pre-dispatch barrier is specified but not wired into the closed runtime.
- Process startup ownership/takeover composition is deferred.
- A concrete Chronik adapter is deferred; the present observer depends only on
  a narrow read-only transaction-observation source.
- UI integration is deferred.
- REGTEST failure-injection with real process termination is deferred until a
  concrete store and barrier exist.
- Mainnet is out of scope.

Accordingly, Phase 6-I-A **does not complete durable crash recovery**. It
defines the fail-closed contract that a later durable store and explicitly
authorized barrier integration must satisfy.
