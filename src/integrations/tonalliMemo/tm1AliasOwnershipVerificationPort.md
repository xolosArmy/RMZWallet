# TM1 alias ownership verification port

Gate B slice 4. Fail-closed mint of `Tm1VerifiedAliasOwnershipToken`
objects for `Tm1AliasPublicationAuthorizer.issue()`.

This is **not** a Chronik client, signer, broadcast path, or publication
enablement. App / routes / RegisterAlias / orchestrator stay unwired.

## Factory

`createTm1AliasOwnershipVerificationPort()` / `create({})`

Public create captures `globalThis.fetch.bind(globalThis)`,
`JSON.parse.bind(JSON)`, body-decode prototype methods
(`TextDecoder.prototype.decode`, `String.prototype.concat`),
stream reader methods
(`ReadableStream.prototype.getReader`,
`ReadableStreamDefaultReader.prototype.read` / `cancel`),
and `AbortController.prototype.abort` / `signal` getter once at
module evaluation and GETs frozen `https://alias.ecash.mx/alias`.
Decoded body text is assembled with captured `concatStrings` on
string primitives; it is not accumulated in an Array and does not
indexed-write chunks that can inherit prototype setters.
`Response.prototype.body` is read through a getter captured at
module evaluation (`getResponseBody`); later replacement of that
getter does not change decode. Stream `cancel()` fulfillment and
rejection are both settled (`settleCancel`); timeout and caller-abort
invoke captured `abortController(controller)` rather than live
prototype dispatch; `fetch` and body read use captured
`getAbortSignal(controller)` rather than live prototype dispatch;
abort listeners are registered via captured `EventTarget.prototype.addEventListener`
and `EventTarget.prototype.removeEventListener`; post-import replacement
of `AbortController.prototype.abort`, `AbortController.prototype.signal` getter,
or `EventTarget.prototype.addEventListener` does not hang pending verify() calls;
abort/timeout still map to `ALIAS_OWNERSHIP_UNAVAILABLE` and do not mint.
CashAddr canonicalization captures `Address.parse.bind(Address)`
in `utils/alias.ts`. `Address.prototype` is frozen and severed from
`Object.prototype` (`null` prototype) at module evaluation to prevent
prototype pollution / setter interception (`this.address = ...`).
`String.prototype` methods (`split`, `toLowerCase`, `toUpperCase`, etc.)
and `Uint8Array.prototype` / `TypedArray.prototype` methods (`subarray`, `set`, `slice`, etc.)
are snapshot at module evaluation; CashAddr parsing runs inside
`runWithIsolatedDecoder`, guaranteeing 100% deterministic decoding
immune to post-import string and typed array prototype tampering,
and failing closed immediately if any prototype method cannot be restored.
`cash()` / `toString()` are instance own
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

Same-realm patch of fetch / JSON.parse / decode / concat /
stream reader / `Response.prototype.body` / `AbortController.prototype.abort` /
`AbortController.prototype.signal` / `EventTarget.prototype.addEventListener` /
`Address.parse` / `String.prototype.split` / `Date.now` *before*
this module (or `utils/alias.ts` or `utils/clock.ts`) is first evaluated is process load-order,
not a module API. This slice does not pin undici/native fetch.
Request-time expiry uses captured `nowMs`, not live `Date.now()`.
The evaluation-time captured clock is shared between the verification port
and the publication authorizer via `utils/clock.ts` to prevent load-order
clock skew attacks. Post-import `AbortController.prototype.abort`, `signal`,
and `EventTarget.prototype.addEventListener` replacements
do not prevent verifier timeout or caller-abort from cutting hanging requests.
`Address.prototype.cash` / `toString` post-import swaps do not mint: those
methods are own properties on each parsed instance. Post-import
`Address.prototype` setter injections are rejected by `Object.freeze` and
cannot intercept constructor assignments. Post-import `String.prototype.split`
or `toLowerCase` replacements, as well as `Uint8Array.prototype` / `TypedArray.prototype.subarray`, `slice`, or `set`
replacements or shadowing, cannot forge parsed address payloads because
`runWithIsolatedDecoder` restores authentic method descriptors during parsing,
failing closed (throwing immediately and aborting verification) if any prototype
property was made non-configurable.
Post-import `Array.prototype` index setters do not mint: body text is not
accumulated in an Array.

**NOT SUFFICIENT TO ENABLE PUBLICATION.**
