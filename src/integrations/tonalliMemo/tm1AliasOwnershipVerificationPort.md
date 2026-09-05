# TM1 alias ownership verification port

Gate B slice 4. Fail-closed mint of `Tm1VerifiedAliasOwnershipToken`
objects for `Tm1AliasPublicationAuthorizer.issue()`.

This is **not** a Chronik client, signer, broadcast path, or publication
enablement. App / routes / RegisterAlias / orchestrator stay unwired.

## Factory

`createTm1AliasOwnershipVerificationPort()` / `create({})`

Public create binds `globalThis.fetch` and frozen
`https://alias.ecash.mx/alias` inside the module. Passing `fetch`,
`endpointUrl`, `observe`, or `clock` is extra input
(`INVALID_ALIAS_AUTHORIZATION_INPUT`).

Tests use `createTm1AliasOwnershipVerificationPortForTests({ fetch, clock })`
from `tm1AliasOwnershipVerificationPort.testFetch.ts`, which App / routes
must not import.

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
