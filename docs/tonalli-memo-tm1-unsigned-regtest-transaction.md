# TM1 Draft 0.2 unsigned deterministic fixture transaction

This module converts a validated `Tm1Draft02Candidate` into deterministic unsigned transaction bytes for fixtures only.

It is intentionally isolated from wallet state, keys, signing, authorization, network access, and transmission.

## Runtime module

```text
src/integrations/tonalliMemo/tm1Draft02UnsignedTransaction.ts
```

The module provides four boundaries:

1. `decodeTm1Draft02CandidateEffectiveContent`
   - strictly decodes the canonical binding produced in PR 5-D;
   - rebuilds the candidate through the runtime-validating constructor;
   - rejects trailing bytes, truncation, invalid fields, inconsistent fee data, and non-canonical encodings.

2. `serializeTm1Draft02UnsignedTransaction`
   - writes deterministic Bitcoin/eCash-style unsigned transaction bytes;
   - encodes txids in serialized little-endian order;
   - encodes output indices, sequences, values, scripts, and locktime;
   - writes empty scriptSig fields for every input;
   - uses minimal CompactSize encodings.

3. `parseTm1Draft02UnsignedTransaction`
   - independently parses the unsigned bytes;
   - rejects truncated data, trailing data, oversized vectors or scripts, and non-minimal CompactSize encodings;
   - reserializes the parsed structure and requires exact byte identity.

4. `auditTm1Draft02UnsignedTransaction`
   - decodes the approved candidate binding;
   - parses the unsigned transaction independently;
   - verifies transaction version and locktime;
   - verifies input count, outpoint order, sequences, and empty scriptSigs;
   - verifies that input zero remains the designated author input;
   - verifies output count, exact TM1 OP_RETURN, exact change amount and script;
   - derives the fee from committed prevout values and parsed outputs;
   - enforces the committed fee and maximum fee;
   - requires exact equality with a fresh deterministic serialization.

## Unsigned transaction envelope

`encodeTm1Draft02UnsignedTransactionEnvelope` creates an additional fixture artifact containing:

```text
TONALLI\0TM1-DRAFT-02-UNSIGNED-TX\0
canonical effectiveContent
unsigned transaction bytes
```

Each variable field is length-prefixed. This envelope is not a transaction and is not accepted by a node.

## Security boundary

This milestone does not:

- query Chronik or another network;
- access wallet state;
- read a mnemonic or private key;
- derive a signatory;
- register an authorization profile;
- call `externalSign`;
- sign any input;
- add scriptSig signatures;
- broadcast;
- modify WalletConnect;
- connect to the 5-C UI;
- enable mainnet or production behavior.

The transaction bytes are unsigned fixture bytes. They are not ready for broadcast and are not proof that any referenced UTXO exists.

## Future boundary

A later fixture-only signing adapter may consume these audited bytes only after:

- universal authorization review;
- read-only fixture-state revalidation;
- one-time capability consumption;
- deterministic signing;
- independent post-signature parsing and audit.

That future adapter must remain unregistered and disconnected from production routes until separately authorized.
