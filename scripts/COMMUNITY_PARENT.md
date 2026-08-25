# Community Parent preparation tool

`npx tsx scripts/create-community-parent.ts` prepares an offline preview for a future
`SLP NFT1 Group` Genesis. Its capability level is limited to metadata validation,
pure-XEC funding selection, canonical OP_RETURN construction, and an unsigned
output plan. It never derives keys, signs, contacts Chronik, uploads metadata, or
broadcasts a transaction. The community trust-registry entry remains closed and
is not changed by this tool.

## Verified protocol choices

- The installed `ecash-lib` 4.5.2 API is
  `slpGenesis(tokenType, genesisInfo, initialQuantity, mintBatonOutIdx?)`.
- NFT1 Group uses SLP token type `129` and this tool fixes `decimals = 0`.
- `ecash-lib` can encode a zero initial quantity, but an NFT1 Child must consume
  a positive Group quantity. The tool therefore chooses the minimum immediately
  useful and conservative quantity, `1`, instead of `0` or the existing official
  Parent's much larger issuance. Quantity `1` is an internal invariant and is
  not configurable by the operator.
- `vout 0` is the SLP Genesis, `vout 1` receives that one Group atom, and the
  retained mint baton is explicitly assigned to `vout 2`. `ecash-lib` rejects a
  baton index below `2`.
- Token and baton outputs use the repository's existing `XEC_DUST_SATS` policy.

## Metadata commitment

The exact bytes checked in at `scripts/metadata/community-parent.json` are bound
to the frozen SHA-256 digest
`03cd44ce490769d5646b39c84b488d2894b2b6c4958b085f2cc906c1d36a09a6`.
The CLI hashes the file and aborts if any byte differs. The builder always uses
that frozen digest in `GenesisInfo.hash`; callers cannot provide metadata bytes
or a replacement hash. The explicit `ipfs://` document URI is a separate field,
validated with `multiformats` as a canonical CIDv0 or base32 CIDv1. A CID is
never substituted for the SHA-256 document hash.

The project declares and locks `multiformats@9.9.0` directly because the planner
imports its CID parser. If that dependency disappears, tests and CLI module
loading fail rather than falling back to permissive URI validation.

Publishing those exact bytes and selecting the final URI are separate
administrative actions. This tool performs no Pinata or IPFS upload.

## Dry-run inputs

All configuration is explicit and supplied through environment variables:

```text
COMMUNITY_PARENT_NETWORK=mainnet|testnet|regtest
COMMUNITY_PARENT_FUNDING_ADDRESS=<network-matching P2PKH cashaddr>
COMMUNITY_PARENT_TOKEN_ADDRESS=<network-matching P2PKH cashaddr>
COMMUNITY_PARENT_BATON_ADDRESS=<network-matching P2PKH cashaddr>
COMMUNITY_PARENT_CHANGE_ADDRESS=<network-matching P2PKH cashaddr>
COMMUNITY_PARENT_DOCUMENT_URI=ipfs://<published CID>
COMMUNITY_PARENT_UTXOS_FILE=/path/to/offline-utxos.json
```

The quantity, token type, decimals, name, ticker, document hash, and baton index
are not operator inputs. The UTXO file must be a JSON array whose entries use
decimal strings for satoshis:

```json
[
  {
    "outpoint": {
      "txid": "<64 lowercase hex characters>",
      "outIdx": 0
    },
    "sats": "10000",
    "outputScript": "<funding address P2PKH script hex>",
    "isCoinbase": false
  }
]
```

Any entry with a `token` annotation is rejected rather than filtered. The
builder also rejects duplicate, coinbase, malformed, wrong-address, or
insufficient funding.

## Planner-only boundary

This command only produces an offline preview/build artifact. The plan is not
authorization to broadcast. It contains no executor, signer port, broadcaster
port, wallet integration, or live Chronik revalidation.

If either former execution flag is present, the command aborts explicitly:

```text
BROADCAST=1
CONFIRM_COMMUNITY_PARENT_GENESIS=YES
```

Actual creation of the Parent requires the separately reviewed administrative
executor described below. Neither execution capability belongs to the planner
or changes this planner-only command.

No WIF, mnemonic, seed, or private key is accepted as a CLI argument or printed.

## Guarded administrative executor

`npx tsx scripts/broadcast-community-parent.ts` is a separate, mainnet-only
administrative boundary. Its default invocation reads live UTXOs through the
wallet's canonical Chronik configuration, calls the canonical planner, builds a
complete unsigned transaction, prints the exact endpoint, outputs, fee, change,
and deterministic plan fingerprint, then stops with zero signing and zero
broadcasting.

An execution requires all three exact gates:

```text
BROADCAST=1
CONFIRM_COMMUNITY_PARENT_GENESIS=YES
CONFIRM_PLAN_SHA256=<the exact reviewed fingerprint>
```

After the gates match, the executor fetches Chronik again, rebuilds the plan,
and requires the fresh fingerprint to remain identical. It then lazily reads a
32-byte lowercase hex signing secret only from
`COMMUNITY_PARENT_SIGNING_SECRET_HEX`. The command accepts no CLI arguments,
never prints or persists that value, and clears the decoded byte array after
signing.

Before its single broadcast attempt, the executor validates the signed
transaction locally and through Chronik `validateRawTx`. It checks the exact
inputs, canonical SLP NFT1 Group OP_RETURN, quantity output, baton output,
optional change, and fee guard. A transport error after the broadcast attempt is
reported as ambiguous with the locally computed candidate txid; there is no
automatic retry. A returned txid is never written to the trust registry.
