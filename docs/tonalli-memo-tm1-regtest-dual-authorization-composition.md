# TM1 regtest dual authorization composition

Phase 6-E adds an authorization-only factory that creates one shared
`UniversalAuthorizationCore`, one signing authorization adapter, and one
broadcast authorization adapter. It returns only the two least-authority ports
needed by the existing publication orchestrator:

```text
createTm1RegtestDualAuthorizationPorts(...)
  -> signingAuthorization
  -> broadcastAuthorization
```

The factory does not create an orchestrator and has no signer, transaction
audit, wallet, private key, chain client, Chronik client, delivery transport,
or broadcast capability.

## Scope and concurrency

One composition instance belongs to one orchestrator and one publication flow
at a time. It is not an application singleton or a multi-session scheduler.
The shared core has one active authorization slot and fails fast when SIGN and
BROADCAST authorization are attempted concurrently. It does not queue the
second operation.

The injected operation lock is composition-local. It must be dedicated to this
composition/core and must not intentionally be shared with an independent
orchestrator or another 6-E composition. The injected approval ledger has the
opposite lifetime option: it may be durable and shared more broadly.

The ledger must reject a consumed capability ID globally across operations,
profiles, and publication cycles. Phase 6-E does not implement a ledger or
change the generic ledger interface.

## Capability allocation

When `createCapabilityId` is absent, the composition leaves the core's native
cryptographically random allocator untouched. When a custom allocator is
injected, the composition wraps it with a composition-lifetime issued-ID set.
A capability ID is burned when issued, before downstream authorization
succeeds or fails, and a repeated custom ID fails closed before another grant
can escape. The shared ledger remains the durable consumption defense.

The core generates authorization IDs; both TM1 adapters return the consumed
capability ID as their authorization evidence. The broadcast adapter also
retains its existing defense that rejects equality with the signing
authorization ID.

## Operation IDs

The composition receives one `createOperationIdSuffix()` source and creates:

```text
SIGN:      tm1-regtest.signing-authorization:<suffix>
BROADCAST: tm1-regtest.broadcast-authorization:<suffix>
```

Full operation IDs, not raw suffixes, are tracked for the composition lifetime.
The same raw suffix is valid once in each profile because the resulting full
IDs differ. Reissuing the same full signing or broadcast operation ID fails
closed, including after rejection, expiry, abort, or another failed operation.

## Separate providers and consents

The signing and broadcast decision providers must be different object
identities. Passing the same object for both fails synchronously. Two instances
of the same provider implementation class are allowed. Reference inequality
prevents direct accidental aliasing but cannot prove that two wrappers do not
delegate to the same backend.

SIGN consent remains bound by the closed signing adapter to `preparedId` and
`bindingHash`. BROADCAST consent remains independently bound by the closed
broadcast adapter to `signedId`, `txid`, and `signedArtifactHash`. Provider
requests and decisions are never forwarded between adapters. The broadcast
provider receives no `signingAuthorizationId`; the signing provider receives
no signed artifact or broadcast intent.

## Shared-core lifecycle

An approved SIGN operation consumes its capability, reaches terminal
`authorized`, clears its timer and external abort listener, releases its lease,
and releases the core's active slot before the grant returns. BROADCAST can
therefore start immediately with a fresh internal signal and capability. The
same cleanup applies after rejection, expiry, abort, provider failure, malformed
provider output, and non-cooperative-provider cancellation.

An old internal SIGN signal cannot poison BROADCAST or a later publication
cycle. The unchanged orchestrator owns reset and publication state; the
composition adds no reset API.

## Future multi-session migration

A future concurrent production runtime should use:

```text
one core per orchestrator/session
+ one shared durable ledger
+ a globally collision-resistant capability allocator
+ explicitly scoped per-session locks
```

That migration must preserve the separate SIGN and BROADCAST profiles, content
hashes, providers, and human consents.
