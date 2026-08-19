# TM1 regtest signing authorization adapter (Phase 6-C)

Phase 6-C provides a framework-independent adapter from the signing-authorization port of the TM1 regtest publication orchestrator to `UniversalAuthorizationCore.startAuthorization()`. It authorizes one exact signing intent. It does not sign, read chain state, or broadcast.

## Boundary

The dependency direction is fixed:

```text
Tm1RegtestPublicationOrchestrator
  -> Tm1SigningAuthorizationPort
  -> Tm1RegtestAuthorizationAdapter
  -> UniversalAuthorizationCore.startAuthorization()
```

The adapter receives a prebuilt `UniversalAuthorizationCore`. Phase 6-C intentionally supplies no production lock, approval ledger, runtime composition, route, UI, or profile registration.

Its other injected dependencies are a decision provider, clock, TTL, operation-ID source, and requester metadata. The bindings are snapshotted during construction. The provider sees a frozen copy containing only `operationId`, `preparedId`, `bindingHash`, the review material, expiry, and the universal content hash. It receives the core's read-only internal `AbortSignal`.

The provider receives no signer, wallet, key, WIF, UTXO source, Chronik client, broadcast port, transport, React state, WalletConnect session, or browser persistence capability.

## Exact authorization binding

The port's original `preparedId` and `bindingHash` remain authoritative. Phase 6-B defines `bindingHash` as lowercase hexadecimal SHA256d of `review.effectiveContent`. The adapter validates the canonical 32-byte representation, verifies it against the snapshotted effective bytes with the same SHA256d primitive, and enforces the exact outer/nested relationship. It does not reconstruct or reinterpret transaction semantics.

The universal review uses this binary effective-content payload:

```text
uint32_be(byte_length(UTF8(DOMAIN)))
|| UTF8(DOMAIN)
|| uint32_be(byte_length(UTF8(preparedId)))
|| UTF8(exact preparedId)
|| decode_lowercase_hex(exact bindingHash)
```

where:

```text
DOMAIN = "tonalli.tm1-regtest/signing-authorization/v1"
```

There is no JSON serialization, locale conversion, delimiter concatenation, or alternate hash interpretation.

Fixed vector for `preparedId = "prepared-1"` and `bindingHash = 0x11` repeated 32 times:

```text
0000002c746f6e616c6c692e746d312d726567746573742f7369676e696e672d
617574686f72697a6174696f6e2f76310000000a70726570617265642d31
1111111111111111111111111111111111111111111111111111111111111111
```

`UniversalContentHash` is intentionally different from the TM1 `bindingHash`: the universal hash additionally binds the authorization envelope and the canonical payload above. A successful result returns the original TM1 `preparedId` and `bindingHash`, never the universal hash in their place.

## Lifecycle and grant semantics

The positive lifecycle is:

```text
receiving -> preparing -> reviewReady -> approving -> revalidating -> authorized
```

The adapter reconstructs the same frozen universal review in `prepareReview()` and `revalidateReview()`. Both operations are pure with respect to chain state. The core verifies review and hash stability and consumes its existing one-use approval capability before producing `UniversalAuthorizationGrant`.

Before returning `approved`, the adapter defensively snapshots and validates the grant's nonempty `authorizationId`, exact operation ID, exact universal content hash, and exact valid expiry. `authorizationId` is the identifier of an already-consumed capability. It is evidence of the completed authorization step, not a reusable bearer permission. Aborting after ledger consumption never restores or unburns it.

The effective core terminal must be exactly `authorized` before a grant can be observed. If expiry wins after ledger consumption, the adapter returns TM1 `expired`; the consumed capability remains permanently burned and no `approved` result reaches Phase 6-B.

Phase 6-B remains responsible for fresh network/UTXO revalidation after authorization and before invoking its signer.

## Decisions, expiry, and cancellation

Provider decisions are limited to `approved` or `rejected`. Rejection calls the core handle's `reject()` and maps to the TM1 rejected decision.

Expiry belongs exclusively to `UniversalAuthorizationCore`. While the provider is pending, expiry aborts the handle's internal signal. Classification order is:

1. externally aborted signal -> throw a standard `AbortError`;
2. core state `expired` -> return TM1 `expired`;
3. core state `aborted` -> throw `AbortError`;
4. expected core state `rejected` -> return the provider's TM1 rejection;
5. any other terminal or state -> normalized adapter/core failure.

After asking the core to reject, the adapter rereads the effective terminal
instead of assuming `rejected` won. This closes the deterministic race where
the provider rejects while the core clock has already reached expiry.

The external signal is passed to `startAuthorization()` and therefore bridged before prepare or other externally controlled authorization callbacks. The adapter also checks cancellation before request snapshotting, after external calls, before authorization, and before returning a grant.

## Trust-boundary handling

The adapter acquires its active-operation guard before inspecting caller input. It reads own data properties without invoking accessors, validates the complete review material it forwards, clones byte arrays and collections before the first await, and emits new frozen result objects. Concurrent or reentrant calls fail closed. The guard is released after rejection, expiry, abort, or failure so a later independent request can retry.

Malformed provider decisions, handles, prepared reviews, and grants never produce `approved`. External abort is normalized for the unchanged Phase 6-B abort classifier; other dependency failures are represented by `Tm1RegtestAuthorizationAdapterError` codes without leaking external error objects.

## Deliberate exclusions

Phase 6-C contains no UI or approval modal, route or hook, local/session storage, product wallet state, WalletConnect/x402 integration, signer, private key, Chronik access, transmission, mainnet support, Firma Alpha integration, or broadcast authorization. Mounting and runtime composition are later concerns.
