# Tonalli Memo TM1 Draft 0.2 preview

Tonalli Wallet exposes a non-signing preview route at:

```text
/memo/draft/tm1
```

The preview is intentionally limited to protocol encoding and human inspection. It does not:

- read wallet UTXOs;
- access private keys;
- construct a signed transaction;
- sign inputs;
- broadcast through Chronik;
- enable TM1 production use.

## Draft status

TM1 remains Draft 0.2. The candidate LOKAD ID is:

```text
544d4d00
```

This implementation does not finalize or universally reserve that identifier.

## Encoded form

The preview constructs:

```text
OP_RETURN <544d4d00> <0x01 || 0x01 || author_input_index || event_data>
```

where:

- version `0x01` means TM1 Draft 0.2;
- event type `0x01` means `POST`;
- `author_input_index` is an unsigned integer from 0 through 255;
- `event_data` is preserved as exact UTF-8 bytes.

The encoder does not trim whitespace, normalize Unicode, rewrite line endings, or replace invalid content.

## Product limit

The protocol draft permits up to 212 event-data bytes. This preview applies the smaller Tonalli Wallet product limit of 80 UTF-8 bytes.

## Deterministic funding plan

The module `src/integrations/tonalliMemo/tm1Draft02Plan.ts` adds a pure planning boundary for ordinary self-funded posts.

The planner:

- requires `author_input_index = 0` as a Tonalli Wallet product policy;
- accepts UTXOs as caller-provided data and does not query Chronik itself;
- accepts only token-free UTXOs whose locking script exactly matches the active standard P2PKH script;
- orders eligible UTXOs by satoshis descending, then txid ascending, then output index ascending;
- places the first selected UTXO at input index 0 as the designated author input;
- adds further eligible UTXOs in the same deterministic order when required;
- estimates transaction size using a documented 149-byte signed P2PKH input assumption;
- estimates the network fee using the configured satoshis-per-byte rate;
- requires change back to the active P2PKH script to remain at or above the dust threshold;
- plans output 0 as the zero-value TM1 OP_RETURN and output 1 as change.

The planner does not prove that the caller-provided UTXOs exist, are unspent, or are controlled by the user. Those remain integration responsibilities.

The protocol itself does not require all TM1 authors to use input zero. Verifiers must continue honoring the encoded `author_input_index`. Input zero is only the Tonalli Wallet policy for ordinary self-funded posts.

## Fee-estimation boundary

The fee is an estimate, not a signed-transaction measurement. It assumes a conventional signed P2PKH input size of 149 bytes and includes:

- transaction version and locktime;
- CompactSize input and output counts;
- the exact TM1 OP_RETURN script length;
- one standard P2PKH change output.

A later transaction-building milestone must compare the estimate with the actual serialized transaction before any authorization or broadcast is permitted.

## Security boundary

The generated hexadecimal script and funding plan are preview artifacts only. They must not be interpreted as:

- proof that a selected input exists or is unspent;
- proof that the selected input belongs to the user;
- a signed transaction;
- an exact final fee quote;
- a broadcast authorization;
- a mainnet-ready publication.

UTXO retrieval, ownership binding, key access, transaction construction, signing, human approval, broadcast, confirmation handling, and production policy remain future milestones.
