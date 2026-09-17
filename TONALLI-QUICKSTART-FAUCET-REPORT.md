# Tonalli Quick Start + Welcome XEC — Integration & Release UX Gate

**Date:** 2026-09-17  
**Recommendation:** GO — Quick Start ready for TM-COMM M1 / Xolos Ramírez integration  
**Merge:** not performed (forbidden for this gate)

This report is the canonical evidence for the Quick Start / Welcome XEC restructure. It does not merge either branch.

---

## Exact SHAs (resolved before edits)

| Repo | Ref | SHA |
|---|---|---|
| RMZWallet `origin/main` (BASE) | `ab0024a97ac62f9ba3725b92c553805cb348c7fb` | `[Gate C3A] Settlement Engine #96` |
| RMZWallet branch (pre-edit HEAD) | `39c078643a6d8df2cfc91654c453caca8b0f0521` | existing Quick Start primitives |
| RMZWallet branch (post-edit HEAD) | *recorded after commit in the closing table* | this gate |
| tonalli-faucet `origin/main` (BASE) | `f1964d220d23b214141e722ea5781adee32c0fc9` | faucet main |
| tonalli-faucet branch (pre-edit HEAD) | `94235140fac0f22430929a5d2f1fb6bbc71554a3` | existing Welcome Claim |
| tonalli-faucet branch (post-edit HEAD) | *recorded after commit in the closing table* | this gate |

Working copies:

- `/home/xolosarmy/ecashschool/RMZWallet-quickstart` on `feat/tonalli-quickstart-onboarding` (worktree; canonical TM-COMM A0 checkout left untouched)
- `/home/xolosarmy/ecashschool/tonalli-faucet` on `feat/welcome-xec-one-time-claim`

No parallel equivalent branches were created. No force-push. No production deploy. No real funds.

---

## 0. Delta audit of existing work

The pre-edit branches were **primitives only**.

RMZWallet vs BASE (`ab0024a…`): three unused files.

- `src/services/quickStartStorage.ts` — WebCrypto AES-GCM, non-extractable `CryptoKey`, IndexedDB
- `src/components/QuickStartHydrator.tsx` — not mounted; called `restoreWallet(mnemonic)`
- `src/services/welcomeFaucet.ts` — HTTP client, unwired

tonalli-faucet vs BASE (`f1964d2…`): four files.

- `backend/src/welcomeClaims.ts` — address PK, reservation, retryable vs needs_review
- `backend/src/routes/welcome.ts` — `POST /starter-pack` one-time XEC
- `backend/src/routes/welcome.test.ts` — first claim, duplicate, concurrency, timeout, retryable, invalid address
- `backend/src/index.ts` — welcome router mounted first

The legacy `faucetRouter.post("/starter-pack")` still existed as a second XEC+RMZ cooldown algorithm, shadowed only by mount order.

---

## Lifecycle

```text
UNINITIALIZED
      │
      ▼
QUICK_START_UNBACKED
      │
      ├── view balance
      ├── receive
      ├── Welcome XEC
      ├── future TM-COMM boundary (capability reserved, internals not implemented)
      │
      └── protect wallet
              │
              ▼
       BACKUP_VERIFIED
              │
              ▼
       full Wallet capabilities
```

Single source of truth: `resolveWalletLifecycle({ initialized, backupVerified })`.

Transient UI states (`creating`, `hydrating`, `claiming`, `backing_up`) are **not** persisted.

There is still one Wallet. Quick Start is a lifecycle of that Wallet, not a second wallet.

---

## Capability matrix

| Capability | `QUICK_START_UNBACKED` | `BACKUP_VERIFIED` |
|---|---|---|
| VIEW_BALANCE | allow | allow |
| RECEIVE_XEC | allow | allow |
| WELCOME_XEC_CLAIM | allow | allow |
| BACKUP_WALLET | allow | allow |
| REFRESH_BALANCE | allow | allow |
| RESUME_SAFE_INTENT | allow | allow |
| TM_COMM | **blocked** (reserved future) | declared, internals not implemented |
| SEND_XEC / SEND_RMZ / SEND_FIRMA | block | restore existing |
| ETOKEN / NFT / AGORA / ALIAS_SPEND | block | restore existing |
| WALLETCONNECT / X402 / EXTERNAL_SIGNING | block | restore existing |
| AGENT_WALLET_EXECUTION / ARBITRARY_BROADCAST | block | restore existing |

Central policy: `src/domain/walletCapabilities.ts`.  
Defense in depth: existing `if (!initialized \|\| !backupVerified)` throws on send/alias methods were **kept**.

---

## Seed storage architecture

Quick Start record (IndexedDB `tonalli-quickstart-v1`):

- `version`
- AES-GCM ciphertext
- IV
- `derivationProfileId` (deterministic rehydrate, default `ecash-standard-1899`)
- public `address` metadata (never used as a key)

Device key: random non-extractable AES-GCM-256 `CryptoKey` in IndexedDB. Fail closed if WebCrypto/IndexedDB/`CryptoKey` persist is unavailable. PIN/password local create remains the safe fallback. **Never plaintext.**

Backup UI reads the mnemonic from Wallet-owned memory (`getMnemonic()`). It is **not** placed in:

- URL / query
- `history.state`
- localStorage / sessionStorage plaintext
- fetch/XHR bodies
- logs

Crash-safe backup:

1. Encrypt with the normal Tonalli PIN store (`xoloswallet_encrypted_mnemonic`)
2. Decrypt and compare to in-memory mnemonic
3. Mark `BACKUP_VERIFIED`
4. Only then delete the Quick Start ciphertext + device key

If verification fails, the Quick Start copy is kept.

---

## Welcome Claim state machine

```text
no row → POST reserves pending → sendtoaddress
  proven no broadcast → failed_retryable (one retry allowed)
  ambiguous / timeout / missing txid → needs_review (no auto transfer)
  success → completed
completed | dry_run_completed → already_claimed (0 extra RPC)
pending | needs_review → pending_review (0 extra RPC)
```

Primary identity: wallet address.  
IP: HMAC audit + rate limit only.

`POST /v1/faucet/starter-pack` is owned **only** by `welcomeRouter`. The legacy XEC+RMZ handler was removed from `faucet.ts`. Social `/claim` remains a separate product.

---

## Deep-link adapter (TM-COMM out of this gate)

```ts
type TonalliIntent =
  | { kind: 'conversation'; peer: string; source?: 'xolosramirez' }
```

Stored in `sessionStorage` key `tonalli_safe_intent_v1`. Parsed from `?intent=conversation&peer=...&source=xolosramirez`. No `privateMessaging` import. No TM-COMM A0 internals.

Future:

```text
xolosramirez.com
      ↓
Tonalli intent
      ↓
Quick Start if necessary
      ↓
Welcome XEC
      ↓
TM-COMM          ← OUT OF THIS GATE
```

---

## Requirement matrix

| Requirement | Implementation | Files | Tests | Evidence | Status |
|---|---|---|---|---|---|
| 0 Existing primitives reused | Storage, faucet client, welcome ledger kept and wired | `quickStartStorage.ts`, `welcomeFaucet.ts`, `welcomeClaims.ts` | storage + welcome tests | delta vs `39c0786` / `9423514` | PASS |
| 1 Canonical lifecycle | `UNINITIALIZED → QUICK_START_UNBACKED → BACKUP_VERIFIED` | `domain/walletLifecycle.ts`, `WalletContext.tsx` | `walletLifecycle.test.ts` | derived from initialized+backupVerified | PASS |
| 2 Capability policy | Wallet-owned allow/deny + existing send throws | `domain/walletCapabilities.ts`, `WalletContext.tsx` | capability tests + architecture | send blocked until backup | PASS |
| 3 No plaintext seed paths | Onboarding/backup no longer put mnemonic in `history.state` | `Onboarding.tsx`, `BackupSeed.tsx` | architecture test | no `state: { mnemonic }` | PASS |
| 4 Harden QS storage | Versioned record, profile, non-extractable key, fail closed | `quickStartStorage.ts` | `quickStartStorage.test.ts` | ciphertext ≠ mnemonic | PASS |
| 5 Deterministic rehydrate | `activateQuickStartFromDevice` uses stored profile, not discovery | `XolosWalletService.ts`, `QuickStartHydrator.tsx` | architecture test | hydrator does not call `restoreWallet` | PASS |
| 6 Happy path UX | Primary **Crear mi Tonalli**, secondary **Ya tengo una wallet** | `Onboarding.tsx` | `Onboarding.test.tsx` | one primary CTA | PASS |
| 7 Progressive backup | Banner + crash-safe encrypt/verify/then delete QS | `ProgressiveBackupBanner.tsx`, `BackupSeed.tsx` | WalletContext quick start test | failed verify keeps QS copy | PASS |
| 8 Welcome XEC UX | Uses `activeWallet.address`, amount from backend config | `WelcomeXecCard.tsx`, `welcomeClaim.ts` | `welcomeClaim.test.ts` | `pending_review` never POSTs | PASS |
| 9 Unify faucet authority | Legacy POST `/starter-pack` removed | `faucet.ts`, `index.ts`, README | `welcome.authority.test.ts` | only welcome owns the path | PASS |
| 10 Intent adapter | Conversation intent persist/resume | `tonalliIntent.ts`, `TonalliIntentCapture.tsx` | `tonalliIntent.test.ts` | no TM-COMM import | PASS |
| 11 Frozen boundaries | C2/C3A/x402/WC/Agora/Memo/Agent/TM-COMM not refactored | architecture tests | `quickStartBoundaries.architecture.test.ts` | no privateMessaging on this branch | PASS |
| 12 Frontend tests | Lifecycle, seed, capabilities, backup, legacy routes | listed below | 2674 vitest + 10 slp | `npm test` exit 0 | PASS |
| 13 Faucet tests | One-time claim, races, ambiguity, invalid address | `welcome.test.ts` | 40 backend tests | `npm test` exit 0 | PASS |
| 14 Human clean profile | Procedure documented; automated path covered | this report | onboarding + context tests | live Firefox profile not driven | **RESIDUAL** |
| 15 Full validation | typecheck/build/tests both repos | commands below | see evidence | lint of **touched** files 0; global `eslint .` remains historically red on BASE | PASS (differential) |

---

## Tests

### RMZWallet

```text
npm test
# Test Files  152 passed (152)
# Tests       2674 passed (2674)
# plus slpNftTxBuilder: 10 passed
npx tsc -b && npx tsc -p tsconfig.tm1-regtest-e2e.json
# exit 0
```

New / extended:

- `src/domain/walletLifecycle.test.ts`
- `src/domain/walletCapabilities.test.ts`
- `src/domain/walletCapabilities.architecture.test.ts`
- `src/services/quickStartStorage.test.ts`
- `src/services/quickStartBoundaries.architecture.test.ts`
- `src/services/tonalliIntent.test.ts`
- `src/services/welcomeClaim.test.ts`
- `src/context/WalletContext.quickStart.test.tsx`
- `src/routes/Onboarding.test.tsx` (happy path)

Global `npm run lint` (`eslint .`) is **historically red on BASE** (`ab0024a`, hundreds of `no-explicit-any` / hooks findings in Tonalli Memo / Agent Wallet). Touched Quick Start files were linted in isolation: **0 errors**. Those historical findings were not remediations of this gate.

### tonalli-faucet

```text
npm test
# tests 40, pass 40
npm run typecheck
npm run build
```

There is no `lint` script in tonalli-faucet.

Welcome tests (mocked RPC, temp sqlite, no real funds): first claim, same wallet twice, sequential double click, parallel reservation, retryable vs needs_review, invalid address, reload status, completed metadata, lost response, ECONNRESET, missing txid, failed_retryable race.

---

## Human acceptance (clean profile)

Exact case: a person without crypto knowledge opens Tonalli for the first time.

Automated coverage of that path:

1. `/onboarding` shows one primary action **Crear mi Tonalli**
2. Create does not show seed / BIP44 / PIN
3. Wallet becomes `QUICK_START_UNBACKED`
4. Receive, balance refresh, Welcome XEC are allowed
5. Send / NFT / WC / x402 / Agent / Agora are blocked
6. Reload hydrates from encrypted Quick Start storage without showing the seed
7. **Protege tu Tonalli** → verify words + PIN → `BACKUP_VERIFIED` → full capabilities
8. Second Welcome claim is `already_claimed` / `pending_review` without a second broadcast

Live Firefox clean-profile click-through against a local Vite + dry-run faucet was **not** driven in this session (no browser automation harness wired to a funded/dry-run Chronik stack). That remains a residual before any production cutover. This gate still forbids production deploy.

---

## Known limitations / residual risks

1. Live clean-profile browser session not executed here.
2. Welcome XEC UI is hidden unless `VITE_TONALLI_FAUCET_URL` is set.
3. `TM_COMM` is a reserved capability only; conversation resume does not open a messenger.
4. Global ESLint on RMZWallet remains red on BASE; not part of this gate.
5. Quick Start IndexedDB is device-local; clearing site data destroys the unbacked wallet (same class of risk as any passwordless device wallet). Backup is the recovery path.
6. `getMnemonic()` remains on the Wallet context for backup/reveal UI. Architecture tests forbid putting that value in router/storage/network.

---

## Commands evidence (this session)

| Check | Repo | Result |
|---|---|---|
| `npx tsc -b` + TM1 e2e tsconfig | RMZWallet | PASS |
| `npm test` | RMZWallet | 2674 + 10 PASS |
| ESLint touched Quick Start files | RMZWallet | 0 errors |
| `npm test` | tonalli-faucet | 40/40 PASS |
| `npm run typecheck` | tonalli-faucet | PASS |
| `npm run build` | tonalli-faucet | PASS |
| Merge | both | **not performed** |

---

## PRs

Created after this report is committed. Titles:

- RMZWallet: `Tonalli Quick Start — progressive self-custody onboarding and Welcome XEC UX`
- tonalli-faucet: `Welcome XEC — one-time crash-safe starter claim per wallet`

`@codex review` is requested on both PRs after they exist. This gate does not merge.
