# Dual derivation compatibility

Tonalli Wallet historically derives its primary eCash identity at
`m/44'/899'/0'/0/0`. A historical encrypted wallet without valid derivation
metadata keeps that path only when read-only autodetection finds no activity
under either supported profile. When activity exists, the detected profile is
authoritative because changing the coin type would produce a different key,
address and UTXO set.

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
source of truth. Stored profile metadata is versioned. Valid metadata selects
the stored profile directly. Missing or malformed metadata on an encrypted
wallet triggers read-only autodetection across both profiles after decryption:

- activity only on 899 recovers and persists Tonalli Legacy;
- activity only on 1899 recovers and persists eCash / Cashtab;
- activity on both requires an explicit profile choice before persistence;
- no activity on either profile preserves the historical Tonalli Legacy 899
  fallback.

This recovery does not alter the encrypted mnemonic and does not sign or
broadcast.

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

For each profile, the mnemonic crosses the private derivation boundary exactly
once to derive its hardened account node: `m/44'/899'/0'` or
`m/44'/1899'/0'`. Production retains only the account's extended-public tuple:

- public key;
- chain code;
- depth;
- index;
- parent fingerprint.

The temporary seed buffer is wiped before the account-public extraction
returns. Discovery, balance scanning, preview metadata and HD owner discovery
reconstruct watch-only nodes from that tuple with `seckey: undefined`, then
derive only the non-hardened receive and change branches `/0/i` and `/1/i`.

Discovery does not create signatories, construct signed transactions or
broadcast. Full private derivation from the mnemonic and complete input path
occurs again only at the signing boundary, after user confirmation and
fresh-state revalidation. FIRMA input ownership includes the profile, account,
branch, index, full path, address and public key; mixed-profile plans are
rejected before a signatory is requested.

`minimal-xec-wallet@2.0.2` is not an identity authority. Its internal child-key
calculation assigns the left HMAC half directly instead of applying the BIP32
`(IL + kparent) mod n` scalar addition, so it does not reproduce BIP32/Cashtab
for the same nominal 1899 path and the public fixture below. Tonalli therefore
never uses `walletInfo.xecAddress`,
`walletInfo.publicKey` or `walletInfo.privateKey` for the active identity,
WalletConnect, x402, dApps, FIRMA change or canonical signing. Those boundaries
use the profile registry and `ecash-lib`; the external wallet object remains a
legacy transport/utility dependency only.

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

A user-controlled manual discovery test confirmed that the same Firma Wallet
mnemonic restored in Cashtab and Tonalli selects 1899 and discovers the same
FIRMA balance and UTXO sats. The mnemonic was never disclosed to this project.
Signing and broadcast remain a separate manual verification after this
identity-boundary correction; work must never request, receive, copy or store
that real seed.
