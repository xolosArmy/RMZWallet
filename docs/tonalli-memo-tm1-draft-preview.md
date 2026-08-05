# Tonalli Memo TM1 Draft 0.2 preview

Tonalli Wallet exposes a non-signing preview route at:

```text
/memo/draft/tm1
```

The preview is intentionally limited to protocol encoding and human inspection. It does not:

- read or select wallet UTXOs;
- access private keys;
- construct a spendable transaction;
- calculate transaction fees;
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

## Security boundary

The generated hexadecimal script is a preview artifact only. It must not be interpreted as:

- proof that the selected input exists;
- proof that the input belongs to the user;
- a signed transaction;
- a broadcast authorization;
- a mainnet-ready publication.

Input selection, fee calculation, signing, broadcast, confirmation handling, and production policy remain future milestones.
