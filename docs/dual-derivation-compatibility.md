# Dual derivation compatibility

Tonalli Wallet historically derives its primary eCash identity at the nominal
path `m/44'/899'/0'/0/0` with the child-key algorithm shipped by
`minimal-xec-wallet@2.0.2`. That engine is not standard BIP32: the same mnemonic
and path produce different keys from `ecash-lib`. Consequently, a derivation
profile identifies both its coin type and its cryptographic engine.

This change adds an explicit interoperable profile at
`m/44'/1899'/0'/0/0`. Coin type 1899 is the current eCash/Cashtab convention:
Cashtab's current `appConfig.derivationPath` is 1899 and `ecash-lib` publishes
`XEC_TOKEN_AWARE_DERIVATION_PATH` with the same full path.

## Profiles

| Profile | Engine | Receive | Change | Policy |
| --- | --- | --- | --- | --- |
| `tonalli-legacy-899` | `minimal-xec-wallet-2.0.2-compat` | `m/44'/899'/0'/0/i` | `m/44'/899'/0'/1/i` | Exact recovery of pre-PR-48 Tonalli wallets |
| `ecash-standard-899` | `ecash-lib-bip32` | `m/44'/899'/0'/0/i` | `m/44'/899'/0'/1/i` | Internal recovery candidate for the short standard-899 compatibility window |
| `ecash-standard-1899` | `ecash-lib-bip32` | `m/44'/1899'/0'/0/i` | `m/44'/1899'/0'/1/i` | Default for new wallets and empty imported seeds |

The profile registry in `src/services/derivationProfiles.ts` is the single
source of truth. Version 2 metadata stores both profile and engine. Version 1
metadata is engine-ambiguous and is therefore recovered through the same
read-only process as missing or malformed metadata. Recovery evaluates all
three candidates after decryption:

- activity only on historical 899 recovers and persists Tonalli Legacy;
- activity only on standard 899 recovers and persists that transition profile;
- activity only on standard 1899 recovers and persists eCash / Cashtab;
- activity on more than one engine requires an explicit choice before persistence;
- no activity on any candidate preserves the historical Tonalli Legacy 899
  fallback.

This recovery does not alter the encrypted mnemonic and does not sign or
broadcast.

## Restore and autodetection

Restoration scans receive and change branches for all three candidates using the
configured Tonalli gap limit. For every profile it records history, UTXOs, XEC
balance, token UTXOs and active-address count.

- activity on exactly one engine selects that engine;
- no activity defaults to eCash / Cashtab;
- activity on multiple engines requires an explicit user choice.

Tonalli does not combine UTXOs from both profiles. Generic token discoveries
are read-only and do not enable arbitrary token sends.

## Security boundary

For every engine, the mnemonic crosses the account derivation boundary once to
derive `m/44'/899'/0'` or `m/44'/1899'/0'`. Production retains only the
account public tuple:

- public key;
- chain code;
- depth;
- index;
- parent fingerprint.

The temporary seed and account-secret buffers are wiped before account-public
extraction returns. Standard 899/1899 discovery reconstructs strict watch-only
`ecash-lib` nodes from that tuple with `seckey: undefined`, then derives `/0/i`
and `/1/i`. The historical algorithm cannot support genuine public BIP32 child
derivation: its public tuple plus chain code deterministically emits HMAC `IL`
as temporary child-secret bytes. The isolated compatibility engine materializes
only those bytes needed for one requested public result and wipes them before
returning address/pubkey metadata.

Discovery does not create signatories, construct signed transactions or
broadcast. Full private derivation from the mnemonic and complete input path
occurs again only at the signing boundary, after user confirmation and
fresh-state revalidation. FIRMA input ownership includes the profile, account,
branch, index, full path, address and public key; mixed-profile plans are
rejected before a signatory is requested.

`minimal-xec-wallet@2.0.2` is not a global identity authority. Its child-key
calculation assigns the left HMAC half directly instead of applying the BIP32
`(IL + kparent) mod n` scalar addition. Tonalli reproduces that behavior only
inside `tonalli-legacy-899`; standard 899 and 1899 always use `ecash-lib` BIP32.
Tonalli never uses `walletInfo.xecAddress`,
`walletInfo.publicKey` or `walletInfo.privateKey` for the active identity,
WalletConnect, x402, dApps, FIRMA change or canonical signing. Those boundaries
use the profile registry and the selected engine; the external wallet object
remains a transport/utility dependency only.

With the burned public mnemonic `abandon ... about`, the regression lock is:

- historical Tonalli 899: `ecash:qr03uhyuv0cen3atackpru04watjlllxtu6aqnedrp`;
- standard BIP32 899: `ecash:qpluxjhhlxfjwsymf9nmctvsdrwzwygadsh2pq0ang`.

Their inequality is intentional and covered by golden tests against the
installed historical dependency.

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
