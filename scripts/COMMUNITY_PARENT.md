# Community Parent preparation tool

`npx tsx scripts/create-community-parent.ts` prepares an offline preview for a future
`SLP NFT1 Group` Genesis. It does not derive keys, sign, contact Chronik, upload
metadata, or broadcast a transaction. The community trust-registry entry remains
closed and is not changed by this tool.

## Verified protocol choices

- The installed `ecash-lib` 4.5.2 API is
  `slpGenesis(tokenType, genesisInfo, initialQuantity, mintBatonOutIdx?)`.
- NFT1 Group uses SLP token type `129` and this tool requires `decimals = 0`.
- `ecash-lib` can encode a zero initial quantity, but an NFT1 Child must consume
  a positive Group quantity. The tool therefore chooses the minimum immediately
  useful and conservative quantity, `1`, instead of `0` or the existing official
  Parent's much larger issuance.
- `vout 0` is the SLP Genesis, `vout 1` receives that one Group atom, and the
  retained mint baton is explicitly assigned to `vout 2`. `ecash-lib` rejects a
  baton index below `2`.
- Token and baton outputs use the repository's existing `XEC_DUST_SATS` policy.

## Metadata commitment

The exact bytes checked in at `scripts/metadata/community-parent.json` are
hashed with SHA-256. That 32-byte lowercase hex digest is passed to the SLP
`GenesisInfo.hash` field. The explicit `ipfs://` document URI is a separate
field; an IPFS CID is never substituted for the SHA-256 document hash.

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
COMMUNITY_PARENT_INITIAL_QUANTITY=1
```

The quantity variable is optional and defaults to `1`. The UTXO file must be a
JSON array whose entries use decimal strings for satoshis:

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

## Broadcast posture

Dry-run is the default. The reusable execution boundary requires both exact
gates below before it can call injected revalidation, signing, and broadcast
ports:

```text
BROADCAST=1
CONFIRM_COMMUNITY_PARENT_GENESIS=YES
```

The CLI in this PR deliberately injects none of those ports and reports that no
signing secret is available, so even both gates cannot create or transmit the
Parent. A later, separately reviewed integration must use the audited wallet,
re-query every selected UTXO immediately before signing, and fail closed if any
outpoint disappears, changes amount, or gains a token annotation.

No WIF, mnemonic, seed, or private key is accepted as a CLI argument or printed.
