# TM1 alias ownership verification port

Gate B slice 4. Fail-closed mint of `Tm1VerifiedAliasOwnershipToken`
objects for `Tm1AliasPublicationAuthorizer.issue()`.

This is **not** a Chronik client, signer, broadcast path, or publication
enablement. App / routes / RegisterAlias / orchestrator stay unwired.

## Factory

`createTm1AliasOwnershipVerificationPort({ observe, clock })`

Both deps are required. There is no default observer, no default clock,
and no in-memory fake in this module. Tests inject both.

- `observe({ alias, ownerAddress, signal? })` → ownership observation
  (confirmed txid, owner address, blockHeight, optional expiresAt)
  or a thrown transport/parse failure.
- `clock()` → trusted millisecond timestamp. Never `request.now`.

## Verify

`port.verify({ alias, ownerAddress, signal? })`

1. Canonicalize alias and CashAddr the same way as the authorizer.
2. Call `observe`. Network/abort/thrown transport → `ALIAS_OWNERSHIP_UNAVAILABLE`.
   Null / extra keys / malformed JSON-shaped results → `ALIAS_PROOF_UNVERIFIABLE`.
3. Unconfirmed, owner mismatch, or `clock() >= expiresAt` → throw, no token.
4. Confirmed matching observation → module-internal mint. The token is
   an empty frozen object whose snapshot lives in a WeakMap. `issue()`
   accepts only that token.
5. `expiresAt`, when present, is copied into the snapshot (not dropped).
6. Observer `blockHeight` is stored only on that snapshot. The port does
   not write the issuer's process-local stale-height map.

`request.now` is an extra field and is rejected.

## Residual

Caller-supplied `{ status: 'confirmed', ... }` is still
`ALIAS_EVIDENCE_UNTRUSTED` at `issue()`.

**NOT SUFFICIENT TO ENABLE PUBLICATION.**
