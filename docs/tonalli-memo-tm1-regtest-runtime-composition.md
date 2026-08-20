# TM1 regtest runtime composition

Phase 6-F adds `createTm1RegtestRuntime()`, a concrete **REGTEST ONLY**
composition root. It is not a generic wallet runtime and has no UI, mainnet,
automatic-approval, or caller-selected signing or transport authority.

## Public boundary

Construction accepts one strict loopback Chronik URL plus two mandatory,
distinct human decision providers with their own TTL and requester metadata.
It is synchronous: parsing and composition happen at construction, while all
Chronik observations remain inside publication operations.

The returned frozen object exposes exactly:

`getState`, `subscribe`, `prepare`, `authorizeAndSign`,
`approveAndBroadcast`, `reconcile`, `confirm`, and `reset`.

It does not expose the orchestrator instance, adapters, authorization core,
lock, ledger, Chronik client, UTXO provider, fixture signer, audit port,
delivery transport, or observer. Signing remains reachable only through
`authorizeAndSign()` after explicit SIGN consent; delivery remains reachable
only through `approveAndBroadcast()` after separate explicit BROADCAST consent.

## Concrete wiring and authority order

The runtime preserves the closed orchestration sequence:

1. attest the exact eCash regtest genesis;
2. freshly read fixture-script UTXOs and prepare the review;
3. obtain human SIGN approval;
4. re-attest and freshly re-read UTXOs;
5. invoke the fixed deterministic regtest signer;
6. run the pure signed-transaction audit and expose `signedReviewReady`;
7. obtain separate human BROADCAST approval;
8. re-audit the exact signed artifact and perform final abort checks;
9. invoke the concrete Chronik regtest delivery transport;
10. observe confirmation or uncertainty without retransmission.

The endpoint constructor in `Tm1ChronikRegtestDeliveryTransport` is the single
URL-policy authority. Its normalized endpoint is reused by the private UTXO
and confirmation components. Only `localhost`, IPv4 loopback, or IPv6
loopback with an explicit port is accepted; credentials, paths, queries,
fragments, malformed URLs, remote hosts, and public service endpoints fail
synchronously. The URL is not evidence of network identity: every lifecycle
attestation verifies `blockchainInfo`, block zero, and the exact eCash regtest
genesis. Delivery re-attests immediately before dispatch.

## UTXOs and coinbase policy

Every provider call queries Chronik anew for the exact deterministic fixture
P2PKH hash. There is no caller-selected script and no cache across preparation
and SIGN revalidation. The response script must equal the fixture locking
script, outpoints and positive bigint satoshi values must be well formed, and
duplicate outpoints fail closed. Token-bearing outputs are excluded. Remaining
outputs are ordered by descending value, then txid, then output index.

Known coinbase outputs are included only after 100 confirmations, calculated
from the observed tip and inclusion height. Known immature outputs are
filtered. A coinbase output whose inclusion height or maturity cannot be
established from the Chronik response fails closed; the runtime does not invent
maturity.

## Fixed signer and exact audit

The signer wrapper calls only `signTm1Draft02RegtestCandidate()`. It accepts no
injected signer or key-loading mechanism and retains all fixture restrictions,
including the compressed public regtest fixture WIF semantics, exact fixture
public key and locking script, input ownership, author/change layout,
`ALL_BIP143`, candidate/unsigned audits, and Schnorr verification. The fixture
secret is absent from public configuration, provider reviews, IDs, ledger
records, returned values, and new error messages.

The audit wrapper parses the signed raw hex and calls the pure
`auditTm1Draft02RegtestSignedTransaction()`. It does not use the in-memory
delivery transport as an audit substitute. The unchanged orchestrator retains
both the initial audit and the post-BROADCAST-approval re-audit, including its
raw bytes, raw hex, txid, artifact hash, fee, output, and binding checks.

## Confirmation and reconciliation

The private observer performs one observation per `confirm()` or `reconcile()`
invocation. It first re-attests regtest, then queries the requested tx. A
missing or mempool transaction yields an unconfirmed observation and is never
promoted to a positive confirmation. A mined transaction receives a positive
count only when both inclusion height and current chain height prove it.
Missing or inconsistent metadata fails closed.

There is no polling loop, sleep, rebroadcast, or access to the delivery
transport. If delivery was invoked and its result is unknown, the unchanged
orchestrator remains `broadcastUncertain`; reconciliation observes only and
never retries transmission.

## Process-lifetime isolation

Each runtime instance owns one fail-fast authorization lease and one in-memory
approval ledger. The lock permits exactly one active authorization and is not
an application-global singleton. The ledger deduplicates consumed capability
IDs globally within that runtime across SIGN, BROADCAST, profiles, operations,
and publication cycles. A duplicate fails closed. Web Crypto generates
operation suffixes and publication IDs; the authorization core supplies its
native Web Crypto capability IDs. `Date.now` is the sole time source.

The runtime is a single-flow object, not a multi-session service. The closed
orchestrator and authorization lock reject overlapping work rather than queue
or create a hidden second flow. Sequential cycles are supported only through
the orchestrator's existing terminal-state `reset()` contract.

A **process restart** loses the in-memory ledger evidence, lock and
orchestrator state, `broadcastUncertain` reconciliation state, and issued-ID
sets. Cryptographic randomness makes accidental collision negligible but is
not durable replay evidence. This is acceptable for Phase 6-F regtest only:
**NOT PRODUCTION / NOT MAINNET DURABILITY**.

## Deferred CLI work

`scripts/run-tm1-regtest-e2e.ts` remains a **legacy fixture harness**. It still
bypasses the Phase 6-B through 6-E two-consent runtime path and must not be
described as secure runtime composition. Its explicit two-step human/CLI
consent migration and live-node smoke belong to Phase 6-G.
