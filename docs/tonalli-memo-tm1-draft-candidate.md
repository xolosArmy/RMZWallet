# TM1 Draft 0.2 deterministic candidate boundary

## Status

This module is a pure, isolated research artifact for deterministic regtest fixtures only.

It does not:

- query Chronik;
- read wallet state;
- access a mnemonic or private key;
- derive or invoke a signatory;
- construct or serialize a transaction;
- register an authorization profile;
- sign;
- broadcast;
- integrate with WalletConnect;
- connect to the TM1 preview UI;
- enable mainnet or production use.

## Closed environment

The only accepted environment is:

```text
deterministic-regtest-fixture
```

The runtime contains no mainnet endpoint or operational chain identifier. Callers cannot substitute another environment without the constructor failing closed.

## Candidate invariants

`createTm1Draft02Candidate` validates and freezes an artifact containing:

- schema and artifact version;
- closed deterministic-regtest environment;
- transaction version and locktime;
- explicit input order;
- unique outpoints;
- sequence for every input;
- full prevout sats and locking script;
- author fixed at input zero;
- exactly two outputs: TM1 OP_RETURN followed by change;
- change back to the author P2PKH script;
- dust policy;
- fee derived from `sum(inputs) - sum(outputs)`;
- maximum approved fee;
- closed `ALL_BIP143` sighash policy.

The TM1 output must be a minimally pushed Draft 0.2 POST envelope with version `0x01`, event `0x01`, and encoded author input index `0`.

## Canonical effective content

`encodeTm1Draft02CandidateEffectiveContent` returns a `Uint8Array` using an explicit binary encoding with:

- domain separation;
- length-prefixed text and scripts;
- fixed little-endian integer encodings;
- preserved input and output order;
- canonical lowercase hexadecimal normalized by the constructor.

The bytes are intended as future authorization `effectiveContent`. They are not transaction bytes and must not be presented as a raw transaction.

## Pure revalidation

`revalidateTm1Draft02Candidate` compares the candidate inputs against caller-supplied fresh UTXO state and throws stable errors for:

- duplicate fresh outpoints;
- missing prevouts;
- changed sats;
- changed locking scripts;
- newly tokenized prevouts.

It performs no network lookup. A future regtest-only adapter may fetch fresh state and then call this pure function, but that adapter is outside this milestone.

## Future work

Before any signing milestone, a separate PR must:

1. build actual unsigned transaction bytes in an isolated regtest environment;
2. prove the serialized transaction matches this candidate exactly;
3. integrate a disabled-by-default authorization profile;
4. revalidate before signing;
5. keep signed-byte delivery separate from broadcasting.
