# TM1 alias ownership verification port

Gate B slice 4. Fail-closed mint of `Tm1VerifiedAliasOwnershipToken`
objects for `Tm1AliasPublicationAuthorizer.issue()`.

This is **not** a Chronik client, signer, broadcast path, or publication
enablement. App / routes / RegisterAlias / orchestrator stay unwired.

## Factory

`createTm1AliasOwnershipVerificationPort({ fetch, clock, endpointUrl?, timeoutMs? })`

`fetch` and `clock` are required. There is no caller `observe()` parameter
and no in-memory fake in this module. Observation is bound to
`https://alias.ecash.mx/alias` (same protocol as `useAliasResolution`).
Tests inject a fetch double from
`tm1AliasOwnershipVerificationPort.testFetch.ts`, which App / routes
must not import.

- `fetch` → HTTP GET of `{endpointUrl}/{alias}`. Never a lambda that
  returns confirmed evidence.
- `clock()` → trusted millisecond timestamp. Never `request.now`.

## Verify

`port.verify({ alias, ownerAddress, signal? })`

1. Canonicalize alias and CashAddr the same way as the authorizer.
2. GET alias.ecash.mx. Network/abort/5xx → `ALIAS_OWNERSHIP_UNAVAILABLE`.
   Empty / invalid JSON / null → `ALIAS_PROOF_UNVERIFIABLE`.
   HTTP 404 → `ALIAS_UNCONFIRMED`.
3. Unconfirmed, owner mismatch, or `clock() >= expiresAt` → throw, no token.
4. Confirmed matching observation → file-private mint (not exported).
5. `expiresAt`, when present, is copied into the snapshot (not dropped).
6. `blockheight` from the API is stored only on that snapshot. The port
   does not write the issuer's process-local stale-height map.

`request.now` is an extra field and is rejected.

## Residual

Caller-supplied `{ status: 'confirmed', ... }` is still
`ALIAS_EVIDENCE_UNTRUSTED` at `issue()`.

**NOT SUFFICIENT TO ENABLE PUBLICATION.**
