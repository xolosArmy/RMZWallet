# Tonalli Memo TM1 Draft 0.2 preview

Tonalli Wallet exposes a non-signing preview route at:

```text
/memo/draft/tm1
```

The route now supports two review layers:

1. exact TM1 Draft 0.2 protocol encoding; and
2. a wallet-backed estimated funding snapshot for the active address.

Neither layer authorizes, signs, broadcasts or enables production TM1 emission.

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
- `author_input_index` is an unsigned integer from 0 through 255 at protocol level;
- `event_data` is preserved as exact UTF-8 bytes.

The ordinary self-funded Tonalli Wallet flow fixes `author_input_index = 0` as product policy. Verifiers must continue honoring the encoded index and must not assume all TM1 transactions use input zero.

The encoder does not trim whitespace, normalize Unicode, rewrite line endings or replace invalid content.

## Product limit

The protocol draft permits up to 212 event-data bytes. This preview applies the smaller Tonalli Wallet product limit of 80 UTF-8 bytes.

## Deterministic funding plan

The module `src/integrations/tonalliMemo/tm1Draft02Plan.ts` provides a pure planning boundary for ordinary self-funded posts.

The planner:

- requires `author_input_index = 0` as Tonalli Wallet product policy;
- accepts UTXOs as caller-provided data and does not query Chronik itself;
- accepts only token-free UTXOs whose locking script exactly matches the active standard P2PKH script;
- orders eligible UTXOs by satoshis descending, then txid ascending, then output index ascending;
- places the first selected UTXO at input index 0 as the designated author input;
- adds further eligible UTXOs in the same deterministic order when required;
- estimates transaction size using a documented 149-byte signed P2PKH input assumption;
- estimates the network fee using the configured satoshis-per-byte rate;
- requires change back to the active P2PKH script to remain at or above the dust threshold;
- plans output 0 as the zero-value TM1 OP_RETURN and output 1 as change.

## Wallet-backed review adapter

The module `src/integrations/tonalliMemo/prepareTm1Draft02Review.ts` connects read-only wallet state to the pure planner.

It:

- reads the active wallet address through `XolosWalletService`;
- converts that address to its standard P2PKH locking script;
- queries Chronik for UTXOs belonging to that address;
- normalizes the returned UTXOs for the pure planner;
- excludes token-bearing UTXOs through the planner;
- returns a public review snapshot containing the active address, author hash160, selected inputs, estimated fee, estimated change, estimated size and exact TM1 script.

The adapter does not read the mnemonic, private key or signatory. It does not construct or serialize a signed transaction and has no broadcast dependency.

Chronik lookup failures and invalid or unavailable active-address state fail closed with explicit review errors.

## UI review boundary

`MemoDraftPreview.tsx`:

- fixes the ordinary-post author input at zero;
- shows the exact message and encoder output;
- exposes only the action `Calcular plan estimado`;
- labels fee, change and size as estimates;
- discards a pending snapshot when the message or active address changes;
- exposes no authorization, signing, publication or transmission action.

A calculated snapshot is informational and may become stale immediately if UTXO state changes.

## Fee-estimation boundary

The fee is an estimate, not a signed-transaction measurement. It assumes a conventional signed P2PKH input size of 149 bytes and includes:

- transaction version and locktime;
- CompactSize input and output counts;
- the exact TM1 OP_RETURN script length;
- one standard P2PKH change output.

A later transaction-building milestone must compare this estimate with the actual serialized transaction before any human approval, signature or broadcast is permitted.

## Security boundary

The generated hexadecimal script, funding plan and wallet-backed snapshot are review artifacts only. They must not be interpreted as:

- proof that a selected input will remain unspent;
- a reservation or lock on any UTXO;
- proof of final transaction bytes;
- a signed transaction;
- an exact final fee quote;
- a human approval capability;
- a broadcast authorization;
- a mainnet-ready publication.

Transaction serialization, UTXO revalidation, content binding, human approval, key access, signing, broadcast, confirmation handling and production policy remain future milestones.
