# TM1 alias ownership verification port

Gate B slice 4. Fail-closed mint of `Tm1VerifiedAliasOwnershipToken`
objects for `Tm1AliasPublicationAuthorizer.issue()`.

This is **not** a Chronik client, signer, broadcast path, or publication
enablement. App / routes / RegisterAlias / orchestrator stay unwired.

## Factory

`createTm1AliasOwnershipVerificationPort()` / `create({})`

Public create captures `globalThis.fetch.bind(globalThis)`,
`JSON.parse.bind(JSON)`, body-decode prototype methods
(`TextDecoder.prototype.decode`, `Array.prototype.join`,
`Array.prototype.push`), and stream reader methods
(`ReadableStream.prototype.getReader`,
`ReadableStreamDefaultReader.prototype.read` / `cancel`) once at
module evaluation and GETs frozen `https://alias.ecash.mx/alias`.
`Response.prototype.body` is read through a getter captured at
module evaluation (`getResponseBody`); later replacement of that
getter does not change decode. Stream `cancel()` fulfillment and
rejection are both settled (`settleCancel`); abort/timeout still
map to `ALIAS_OWNERSHIP_UNAVAILABLE` and do not mint.
CashAddr canonicalization captures `Address.parse.bind(Address)`
in `utils/alias.ts`. `cash()` / `toString()` are instance own
properties created inside `Address` construction, not live
prototype dispatch. Passing `fetch`, `endpointUrl`, `observe`,
or `clock` is extra input (`INVALID_ALIAS_AUTHORIZATION_INPUT`).
Later mutation of those globals/prototypes does not change
transport, decode, or canonicalize.

The production class and factory carry no test constructor. Tests that
need fake HTTP stub `globalThis.fetch`, then `vi.resetModules()`, then
dynamic-import this module. The fetch double in
`tm1AliasOwnershipVerificationPort.testFetch.ts` is not attached to
production exports; App / routes must not import it.

## Verify

`port.verify({ alias, ownerAddress, signal? })` is branded: `this`
must be an instance created by `create()`. Forged
`prototype.verify.call({ observeAliasOwnership }, request)` fails
closed and does not mint. Observation is a file-private lexical
function that closes over the captured `fetchImpl`; it is not
dispatched through `this`.

1. Canonicalize alias and CashAddr the same way as the authorizer.
2. GET alias.ecash.mx. Network/abort/5xx → `ALIAS_OWNERSHIP_UNAVAILABLE`.
   Empty / invalid JSON / null → `ALIAS_PROOF_UNVERIFIABLE`.
   HTTP 404 → `ALIAS_UNCONFIRMED`.
3. Unconfirmed, owner mismatch, or captured `nowMs() >= expiresAt` → throw, no token.
4. Confirmed matching observation → file-private mint (not exported).
5. Mint always writes a finite `expiresAt`: observed value if it is in
   `(now, now+MAX_TOKEN_TTL_MS]`, otherwise `now+MAX_TOKEN_TTL_MS`
   (60_000 ms). Past observed expiry does not mint. Omitted expiry is
   not valid forever. `issue()` requires finite `expiresAt` and
   `nowMs() < expiresAt`.
6. `blockheight` from the API is stored only on that snapshot. The port
   does not write the issuer's process-local stale-height map.

`request.now` is an extra field and is rejected.

## Residual

Caller-supplied `{ status: 'confirmed', ... }` is still
`ALIAS_EVIDENCE_UNTRUSTED` at `issue()`.

Same-realm patch of fetch / JSON.parse / decode / stream reader /
`Response.prototype.body` / `Address.parse` / `Date.now` *before*
this module (or `utils/alias.ts`) is first evaluated is process
load-order, not a module API. This slice does not pin undici/native
fetch. Request-time expiry uses captured `nowMs`, not live
`Date.now()`. `Address.prototype.cash` / `toString` post-import
swaps do not mint: those methods are own properties on each parsed
instance.

**NOT SUFFICIENT TO ENABLE PUBLICATION.**
