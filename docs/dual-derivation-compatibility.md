# Dual derivation compatibility

Tonalli Wallet historically derives its primary eCash identity at
`m/44'/899'/0'/0/0`. Existing encrypted wallets without derivation metadata
must continue to use that path, because changing the coin type would produce a
different key, address and UTXO set.

This change adds an explicit interoperable profile at
`m/44'/1899'/0'/0/0`. Coin type 1899 is the current eCash/Cashtab convention:
Cashtab's current `appConfig.derivationPath` is 1899 and `ecash-lib` publishes
`XEC_TOKEN_AWARE_DERIVATION_PATH` with the same full path.

## Profiles

| Profile | Receive | Change | Policy |
| --- | --- | --- | --- |
| Tonalli Legacy | `m/44'/899'/0'/0/i` | `m/44'/899'/0'/1/i` | Deterministic migration target for pre-existing Tonalli storage |
| eCash / Cashtab | `m/44'/1899'/0'/0/i` | `m/44'/1899'/0'/1/i` | Default for newly created wallets and empty imported seeds |

The profile registry in `src/services/derivationProfiles.ts` is the single
source of truth. Stored profile metadata is versioned. Missing or malformed
metadata attached to an existing encrypted wallet resolves to Tonalli Legacy;
the migration is idempotent and does not alter the encrypted mnemonic.

## Restore and autodetection

Restoration scans receive and change branches for both profiles using the
configured Tonalli gap limit. For every profile it records history, UTXOs, XEC
balance, token UTXOs and active-address count.

- activity only on 899 selects Tonalli Legacy;
- activity only on 1899 selects eCash / Cashtab;
- no activity defaults to eCash / Cashtab;
- activity on both requires an explicit user choice.

Tonalli does not combine UTXOs from both profiles. Generic token discoveries
are read-only and do not enable arbitrary token sends.

## Security boundary

Discovery derives and retains only path, address, public key and hash160
metadata. It does not extract secret keys, create signatories, construct signed
transactions or broadcast. Signing remains after confirmation and fresh-state
revalidation. FIRMA input ownership includes the profile, account, branch,
index, full path, address and public key; mixed-profile plans are rejected
before a signatory is requested.

## Cashtab interoperability test

The test suite uses the public, burned BIP39 vector
`abandon ... about`. For `m/44'/1899'/0'/0/0`, Tonalli must match Cashtab's
published fixture exactly:

- address: `ecash:qrwzys2q6xq98vwz0kjn6ulu5m6yljr5fyc909kalg`;
- pubkey: `03ee1364cd7af3a9ffbbbd886388776a6f92a7b8dd986f6a8578885e4b856f7bfb`;
- hash160: `dc224140d18053b1c27da53d73fca6f44fc87449`.

The test-only private derivation is compared with the public Cashtab fixture,
but production discovery never extracts it.

Primary references, pinned during implementation:

- Bitcoin ABC/Cashtab `cashtab/src/config/app.ts`, commit
  `09ad53356e0fb76157555ce63d169a7428255e8c`;
- Bitcoin ABC/Cashtab `cashtab/src/wallet/index.ts`, same commit;
- Bitcoin ABC `modules/ecash-lib/src/consts.ts`, same commit.

## Firma Wallet status

This work prepares the 1899 path and generic asset discovery, but it does not
claim verified Firma Wallet compatibility. That requires a later, independent
manual test controlled entirely by the user. Work must never request, receive,
copy or store that real seed.
