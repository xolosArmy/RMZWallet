# TM1 Draft 0.2 fixture authorization adapter

## Status

This module is an isolated fixture-only integration used to exercise the existing
`externalSign` authorization core with deterministic TM1 Draft 0.2 artifacts.

It is not registered as a product authorization profile, is not mounted in the
application, and cannot be reached from a route or UI.

## Profile identifier

```text
tonalli.tm1-draft02.fixture-authorization.v1
```

The identifier exists only as an integration constant. The product profile
registry remains empty.

## Dependencies

The adapter requires three injected dependencies:

1. `Tm1Draft02FixtureEffectiveContentSource`
   - supplies canonical TM1 `effectiveContent` for the authorization envelope;
2. `Tm1Draft02FixtureStateProvider`
   - returns deterministic fresh prevout fixtures for the selected outpoints;
3. `Tm1Draft02FixtureSigner`
   - returns deterministic fixture-attested transaction bytes.

There is no default wallet, network, key, signer, or indexer implementation.

## Authorization lifecycle

The existing universal core owns the security lifecycle:

```text
prepareReview
  -> calculate content hash
  -> reviewReady
  -> approve
  -> revalidateReview
  -> compare exact review and hash
  -> consume one-use capability
  -> signApprovedContent once
  -> verify returned content hash
  -> completed
```

The adapter does not implement or bypass capability consumption. It is invoked
by the core only after the capability has been consumed successfully.

## Prepare review

`prepareReview`:

1. reads canonical `effectiveContent` from the injected source;
2. strictly decodes it into a validated `Tm1Draft02Candidate`;
3. deterministically serializes the unsigned fixture transaction;
4. independently audits the unsigned bytes;
5. returns immutable review fields and an exact copy of `effectiveContent`.

The review exposes environment, author input, input/output counts, fee, maximum
fee, unsigned byte length, sighash policy, and fixture-only delivery status.

## Revalidation

`revalidateReview`:

1. decodes the approved `effectiveContent` again;
2. derives the exact ordered outpoint list;
3. asks the injected fixture state provider for fresh UTXOs;
4. revalidates outpoint presence, sats, locking scripts, and token absence;
5. reconstructs the same deterministic review.

Any change causes the universal core's exact review/hash binding check to fail or
the TM1 candidate revalidation to throw before capability consumption.

## Fixture signer

The injected signer receives:

- validated candidate;
- independently audited unsigned transaction bytes;
- universal `contentHash`;
- abort signal.

It returns only bytes. The adapter independently parses and audits those bytes
before returning `UniversalSignedResult`.

## Deterministic fixture attestation

The supplied helper
`createTm1Draft02DeterministicFixtureSignedTransaction` creates a synthetic
attestation inside every input `scriptSig`.

Each attestation commits to:

- fixture domain and version;
- input index;
- universal `contentHash`;
- txid and output index;
- sequence;
- prevout sats;
- prevout locking script;
- fixture sighash marker `0x41`.

This is **not** a cryptographic signature. It does not use secp256k1, a private
key, a public key, DER encoding, or a node-valid P2PKH unlocking script. The
bytes are intentionally unsuitable for network submission.

## Independent signed-byte audit

The signed-byte auditor verifies:

- canonical transaction parsing and minimal CompactSize encodings;
- no truncation or trailing bytes;
- version and locktime;
- exact input count and order;
- exact outpoints and sequences;
- author at input zero;
- every deterministic fixture attestation;
- exact output count, sats, and scripts;
- exact TM1 OP_RETURN;
- exact author change output;
- fee derived from committed prevouts;
- committed maximum fee;
- exact deterministic reserialization.

## Explicit exclusions

This milestone does not:

- register a product authorization profile;
- enable `/external-sign`;
- add an approval UI;
- import or call `XolosWalletService`;
- access mnemonic, WIF, private key, or real signatory;
- import `ecash-lib` or construct a real signature;
- query Chronik or another network;
- use WalletConnect;
- broadcast or submit transactions;
- enable mainnet or production behavior.

## Returned result

A successful adapter call returns only:

```ts
UniversalSignedResult
```

with format:

```text
tonalli.tm1-draft02.fixture-attested-transaction.v1
```

The returned bytes remain fixture artifacts and must never be treated as
broadcast-ready transaction bytes.
