# TM1 regtest broadcast authorization adapter (Phase 6-D)

Phase 6-D adds a framework-independent adapter from the broadcast-authorization port of the unchanged TM1 regtest publication orchestrator to `UniversalAuthorizationCore.startAuthorization()`. The approval it produces authorizes broadcast of one exact signed artifact, subject to the remaining orchestrator checks. The adapter itself does not sign, audit, access chain state, or transmit the transaction. After approval, the orchestrator re-audits the artifact before it may dispatch it.

## Separate human approvals

The two authorization boundaries are deliberately independent:

```text
SIGN      = preparedId + bindingHash
BROADCAST = signedId + txid + signedArtifactHash
```

They use different profiles, payload domains, operation IDs, one-use capabilities, universal content hashes, and authorization IDs. A signing approval cannot satisfy broadcast authorization. The adapter retains the nonempty `signingAuthorizationId` only in its trusted request snapshot, never includes it in broadcast effective content, and never exposes it to the broadcast decision provider. Before returning approval, it rejects any grant whose `authorizationId` equals that signing ID.

## Boundary and dependencies

The dependency direction is:

```text
Tm1RegtestPublicationOrchestrator
  -> Tm1BroadcastAuthorizationPort
  -> Tm1RegtestBroadcastAuthorizationAdapter
  -> UniversalAuthorizationCore.startAuthorization()
```

The adapter receives a prebuilt core, a dedicated decision provider, clock, TTL, operation-ID source, and requester metadata. Construction snapshots these bindings. A future composition root may intentionally share one durable core, operation lock, and approval ledger with the signing adapter; Phase 6-D supplies no runtime composition.

The provider receives only a frozen snapshot with `operationId`, `signedId`, `txid`, `signedArtifactHash`, informational review material, `expiresAt`, `UniversalContentHash`, and the core's internal `AbortSignal`. It receives no signing authorization ID, signer, wallet, key/WIF, audit port, Chronik client, transport, broadcast function, React state, WalletConnect session, or browser persistence.

## Exact broadcast identity

The adapter uses the tuple already established by Phase 6-B:

- `signedId`: the exact signed-review identifier;
- `txid`: canonical lowercase 32-byte hexadecimal, without byte reversal;
- `signedArtifactHash`: canonical lowercase SHA256d of the raw transaction bytes, without byte reversal.

It creates no alternate transaction or artifact hash. `preparedId`, `bindingHash`, fee, outputs, and signed-artifact metadata are informational review fields, not broadcast identity. The orchestrator remains responsible for re-auditing the signed artifact after approval and before transport dispatch.

## Canonical v1 payload

The broadcast effective content is exactly:

```text
uint32_be(byte_length(UTF8(DOMAIN)))
|| UTF8(DOMAIN)
|| uint32_be(byte_length(UTF8(exact signedId)))
|| UTF8(exact signedId)
|| decode_lowercase_hex(exact txid)
|| decode_lowercase_hex(exact signedArtifactHash)
```

where:

```text
DOMAIN = "tonalli.tm1-regtest/broadcast-authorization/v1"
```

There is no JSON serialization, delimiter concatenation, locale conversion, or hash byte reversal. `UniversalAuthorizationCore` applies its own envelope-plus-content hash over these bytes.

Fixed vector for `signedId = "signed-1"`, `txid = 0x22` repeated 32 times, and `signedArtifactHash = 0x11` repeated 32 times:

```text
0000002e746f6e616c6c692e746d312d726567746573742f62726f6164636173
742d617574686f72697a6174696f6e2f7631000000087369676e65642d31
2222222222222222222222222222222222222222222222222222222222222222
1111111111111111111111111111111111111111111111111111111111111111
```

The approved port result is a new frozen object containing the broadcast grant ID and the original `signedId`, `txid`, and `signedArtifactHash`.

## Lifecycle, cancellation, and consumption

The adapter snapshots caller data before its first await and reconstructs the same universal review and effective content in `prepareReview()` and `revalidateReview()`. The core validates stability and consumes a one-use capability before returning a grant. The grant is already-consumed evidence, not a reusable bearer capability.

The provider promise is raced against the core handle's internal abort signal. An already-aborted signal prevents provider invocation. If cancellation wins, the adapter removes its listener, stops awaiting the provider, observes any later provider rejection, ignores any later approval, classifies external abort before core expiry/abort, and releases its active guard in `finally`. A non-cooperative provider cannot retain the authorization indefinitely.

Capability consumption is permanent. A later re-audit failure, caller abort, submission-ID failure, skipped dispatch, or uncertain broadcast does not restore the grant. Post-approval broadcast uncertainty and reconciliation belong to the orchestrator, not this adapter.

## Dispatch ordering and exclusions

The unchanged orchestrator enforces:

```text
prepare
-> signing authorization
-> candidate revalidation
-> signer
-> signedReviewReady
-> broadcast authorization
-> signed-artifact re-audit
-> final abort check
-> deliveryTransport.broadcast
```

Phase 6-D includes no UI, route, hook, local/session storage, wallet runtime state, WalletConnect/x402 integration, private key, signer, Chronik access, mainnet support, delivery transport, or Phase 6-E composition.
