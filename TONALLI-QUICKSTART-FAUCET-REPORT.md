# TONALLI-QUICKSTART-FAUCET-REPORT.md

Canonical gate report for Tonalli Quick Start + Welcome XEC.

This file lives at the root of `xolosArmy/RMZWallet` on branch `feat/tonalli-quickstart-onboarding`. It is the source of truth for review. Read it in full with:

```bash
cat TONALLI-QUICKSTART-FAUCET-REPORT.md
```

Do not depend on GitHub UI, screenshots, or external files to understand the result.

**Merge was not performed. Production was not deployed. Real funds were not used. History was not rewritten. No parallel equivalent branches were opened.**

The authoritative tip of this branch is always:

```bash
git rev-parse HEAD
```

Do not treat this report commit as the implementation HEAD. Implementation HEAD and report commit are listed separately below.

---

## Fecha y estado final del gate

| Campo | Valor |
|---|---|
| Fecha | 2026-09-18 |
| Gate | Tonalli Quick Start — release candidate freeze + exact-head audit |
| Estado | cerrado en ramas de feature; **sin merge** |
| Decisión | **GO — ready for merge review** |
| Justificación | Audit independiente P0=0 / P1=0. Suites RMZWallet y faucet verdes. Faucet `npm test` 3/3 en proceso limpio. Clean-profile dry-run PASS. Sin findings de seguridad nuevos. **No merge** hasta el review exact-head de Codex (cuota agotada). |

---

## Identidades exactas

Verificar en el checkout que contiene este archivo:

```bash
git rev-parse HEAD
git merge-base origin/main HEAD
git log --oneline origin/main..HEAD
```

### RMZWallet (`xolosArmy/RMZWallet`) PR **#99**

| Campo | Valor |
|---|---|
| Rama | `feat/tonalli-quickstart-onboarding` |
| BASE `origin/main` | `ab0024a97ac62f9ba3725b92c553805cb348c7fb` |
| HEAD al inicio de esta revisión (referencia, no asumir) | `9e5aed17448d4cece6759f32ca7a18c436ff2865` |
| HEAD de implementación (este pass) | `2050b35e80bda11ed85373284717b08425b77b14` |
| HEAD de reporte | el commit de este archivo; **no** es el HEAD de implementación |
| Tip autoritativo | `git rev-parse HEAD` |
| PR | **#99** OPEN, no mergeado |
| URL | https://github.com/xolosArmy/RMZWallet/pull/99 |
| Base del PR | `main` (`ab0024a97ac62f9ba3725b92c553805cb348c7fb`) |

Checkout de trabajo: `/home/xolosarmy/ecashschool/RMZWallet-quickstart`. El checkout TM-COMM A0 en `/home/xolosarmy/ecashschool/RMZWallet` **no se modificó**.

### tonalli-faucet (`xolosArmy/tonalli-faucet`) PR **#3**

| Campo | Valor |
|---|---|
| Rama | `feat/welcome-xec-one-time-claim` |
| BASE `origin/main` | `f1964d220d23b214141e722ea5781adee32c0fc9` |
| HEAD al inicio de esta revisión (referencia, no asumir) | `c26b70e06bf69568a7b2b5430917a79a3a9fb48c` |
| HEAD Turnstile Quick Start | `4e32338a6aee3411c1d23d0b3257ca18300af841` |
| HEAD de implementación / PR tip (freeze) | `aeb5b2ad4f33f1d09205ea3584f59bfcbb0aae71` |
| PR | **#3** OPEN, no mergeado |
| URL | https://github.com/xolosArmy/tonalli-faucet/pull/3 |
| Base del PR | `main` (`f1964d220d23b214141e722ea5781adee32c0fc9`) |

Checkout de trabajo: `/home/xolosarmy/ecashschool/tonalli-faucet`.

HEADs de implementación de este freeze: RMZWallet `2050b35e80bda11ed85373284717b08425b77b14`, tonalli-faucet `aeb5b2ad4f33f1d09205ea3584f59bfcbb0aae71`. El tip de PR #99 puede incluir commits documentales posteriores.

---

## Commits

### RMZWallet `origin/main..HEAD` (implementación, antes del commit de este reporte)

```
2050b35e80bda11ed85373284717b08425b77b14  fix(onboarding): unlock backed-up Quick Start without waiting on Chronik
cb2ad8b721bf07163ea9ef9c7a26ce9f895de0f1  fix(onboarding): never overwrite an existing Quick Start wallet
9e5aed17448d4cece6759f32ca7a18c436ff2865  docs(onboarding): point canonical report HEAD at git rev-parse
7ef524a2e837323316a7d1db120428700b59e6f4  docs(onboarding): include canonical report commits in the SHA log
ff9c1403ac55ab470b3084f9baf2dd706394d0ce  docs(onboarding): pin canonical report to published SHA
b2c0d89557ec021fe9696250fb27d67cbf1afe12  docs(onboarding): publish canonical TONALLI-QUICKSTART-FAUCET-REPORT.md
fdbee3351dad0bef4e88ffff25bf892060816ac6  docs(onboarding): record exact Quick Start and Welcome Claim SHAs
b67fd2feb163f0e1b5716be5f142f11786480715  feat(onboarding): complete Tonalli Quick Start lifecycle and Welcome XEC UX
39c078643a6d8df2cfc91654c453caca8b0f0521  feat(onboarding): restore encrypted quick start wallet after reload
c7ae51f5456ef0ca844d5180bbf855e805002334  feat(onboarding): add embedded welcome faucet client
32d3819392afc8d13f1ec3933f363e41215d52e6  feat(onboarding): add encrypted passwordless quick start storage
```

### tonalli-faucet `origin/main..HEAD`

```
aeb5b2ad4f33f1d09205ea3584f59bfcbb0aae71  fix(faucet): upgrade better-sqlite3 for Node 24 test isolate teardown
5ee830e6c2b84024999db12e6c26803fea560c8a  test(faucet): do not close SQLite during Node 24 isolate teardown
4e32338a6aee3411c1d23d0b3257ca18300af841  fix(faucet): fail closed when Welcome Quick Start meets Turnstile
c26b70e06bf69568a7b2b5430917a79a3a9fb48c  feat(faucet): make Welcome Claim the sole starter-pack authority
94235140fac0f22430929a5d2f1fb6bbc71554a3  test(faucet): cover one-time welcome claim races and ambiguous broadcast
d890b2e51adaec6cd138def691bd3387f6d78feb  feat(faucet): route starter pack through welcome claim guard
2e4fbb8bc09558037f4293ed1084c022ebf1fd45  feat(faucet): make starter pack a one-time idempotent XEC welcome claim
21d4008c9908dcb767776e149111064a382d5184  feat(faucet): add durable one-time welcome claim ledger
```

---

## Arquitectura (sigue vigente tras el pass)

Una sola Wallet (`XolosWalletService` + `WalletContext`). Quick Start no crea una wallet paralela.

```text
startup
  ↓
check existing Quick Start
  ↓
if exists → recover it
if absent → permit "Crear mi Tonalli"
```

`QuickStartHydrator` es un no-op de composición. El bootstrap lo posee `WalletProvider` (`quickStartBootstrap: pending | absent | recovered | failed`). No se permite crear otra wallet mientras esa decisión está pendiente.

Lifecycle: `UNINITIALIZED → QUICK_START_UNBACKED → BACKUP_VERIFIED` vía `resolveWalletLifecycle({ initialized, backupVerified })`.

`QUICK_START_UNBACKED` permite VIEW_BALANCE, RECEIVE_XEC, WELCOME_XEC_CLAIM, BACKUP_WALLET, REFRESH_BALANCE, RESUME_SAFE_INTENT. Bloquea send/NFT/Agora/WalletConnect/x402/Agent/broadcast.

`TM_COMM` está bloqueado en **los tres** lifecycles actuales. Backup verificado no autoriza mensajería.

Seed Quick Start: IndexedDB `tonalli-quickstart-v1`, AES-GCM, CryptoKey no extractable. Probe de disponibilidad usa `device-key-probe` y lo borra. Nunca plaintext, URL, history.state, localStorage, sessionStorage, logs o red.

Backup crash-safe: cifrar PIN store → verificar decrypt → `BACKUP_VERIFIED` → entonces borrar ciphertext Quick Start.

Welcome XEC: one-time por address, `POST /v1/faucet/starter-pack`, dry-run por defecto. Quick Start requiere `TURNSTILE_ENABLED=false`.

No se acopló TM-COMM A0. No se cambiaron semánticamente C2/C3A/broadcast/Agent Wallet/x402/WalletConnect/Agora/Memo.

---

## Fresh Independent Review Findings

Review-start SHAs (referencia únicamente): RMZWallet `9e5aed17448d4cece6759f32ca7a18c436ff2865`, tonalli-faucet `c26b70e06bf69568a7b2b5430917a79a3a9fb48c`. Los HEAD actuales se resolvieron otra vez antes de editar.

### P0 — Existing Quick Start must never be overwritten

**finding.** Había una ventana en la que una Quick Start persistida podía rehidratarse mientras `initialized=false` y el usuario todavía podía pulsar `Crear mi Tonalli`. `assertQuickStartStorageAvailable()` rotaba el `device-key` de una wallet ya cifrada. Un fallo de Chronik/balance podía dejar una identidad local recuperable como si no existiera.

**root cause.** `persistNonExtractableDeviceKey()` siempre generaba y escribía `KEY_RECORD`. `createQuickStartWallet()` llamaba `createNewWallet()` después del probe. `QuickStartHydrator` competía con `WalletProvider`. `syncAddressAndBalance()` / `wallet.initialize()` trataban un error de Chronik como fallo de identidad.

**fix.**

```text
existing Quick Start record
        ↓
NEVER overwrite key
NEVER overwrite ciphertext
NEVER generate a replacement wallet implicitly
```

- `assertQuickStartStorageAvailable()` es no destructivo: si hay seed o `KEY_RECORD`, no escribe; el probe usa `device-key-probe` y lo borra.
- `persistNonExtractableDeviceKey()` / `storeQuickStartMnemonic()` fallan con `QUICK_START_RECORD_EXISTS` si ya hay ciphertext.
- Seed sin key → `QUICK_START_DEVICE_KEY_MISSING`, fail closed, sin recrear.
- Bootstrap en `WalletProvider`: `pending → absent | recovered | failed`. Create está bloqueado mientras `pending` o `failed`.
- Si existe record: recuperar; si la recuperación falla: `QUICK_START_RECOVERY_FAILED`; no hay reset destructivo en el happy path.
- Identidad local vía `activateMnemonicLocalIdentity`; Chronik/balance es opcional.

**tests.**

- existing Quick Start + second availability check → same key still decrypts (`quickStartStorage.test.ts`)
- existing Quick Start + delayed hydration + click create → no second wallet / same address (`WalletContext.quickStart.test.tsx`)
- existing Quick Start + Chronik unavailable → local identity activates (`WalletContext.quickStart.test.tsx`)
- corrupt/missing device key → fail closed, no automatic recreate (`quickStartStorage.test.ts`)
- architecture: probe no escribe `KEY_RECORD`; `createQuickStartWallet` comprueba `hasQuickStartMnemonic()` antes de `createNewWallet()`

**evidence.** Vitest 2686 + slpNftTxBuilder 10 PASS. Aceptación perfil limpio: Chronik abortado → misma address, botón Crear disabled, no segunda wallet. Unlock PIN post-backup ya no espera `wallet.initialize()`.

**status.** Corregido. No GO: falta review exact-head de Codex.

### P1 — Preserve TonalliIntent until an actual consumer handles it

**finding.** `resumeAfterQuickStart()` llamaba `consumeTonalliIntent()` y descartaba el retorno. El intent `xolosramirez.com → conversation` desaparecía antes de TM-COMM M1.

**root cause.** Onboarding consumía el intent como si Quick Start fuera el consumer.

**fix.**

```text
capture intent
      ↓
persist safely
      ↓
Quick Start if necessary
      ↓
Dashboard / wallet ready
      ↓
intent remains pending
      ↓
future TM-COMM consumer handles it
      ↓
ONLY THEN consume/remove
```

Quick Start puede leer el intent (`readTonalliIntent`) y no lo consume. No se implementó TM-COMM.

**tests.**

- deep link → Quick Start → Dashboard → intent still present
- reload before TM-COMM → intent still present
- explicit consume by consumer → removed exactly once
- architecture: `Onboarding.tsx` no contiene `consumeTonalliIntent`

**evidence.** Tests en `tonalliIntent.test.ts`. Aceptación: `tonalli_safe_intent_v1` permaneció `{"kind":"conversation","peer":"xolos.ramirez","source":"xolosramirez"}` tras capture, Dashboard y reload.

**status.** Corregido. TM-COMM no está en este PR.

### P1 — TM_COMM must remain unauthorized until M1 defines policy

**finding.** `TM_COMM` formaba parte de `FULL_WALLET_CAPABILITIES`, así que `BACKUP_VERIFIED` lo autorizaba.

**root cause.** Backup verificado se trató como permiso de mensajería.

**fix.** `isCapabilityAllowed(..., TM_COMM)` es `false` en `UNINITIALIZED`, `QUICK_START_UNBACKED` y `BACKUP_VERIFIED`. `FULL_WALLET_CAPABILITIES` ya no incluye `TM_COMM`.

**tests.** Architecture test exige `TM_COMM=false` para los tres lifecycles actuales. WalletContext Quick Start comprueba `TM_COMM=false` también después del backup.

**evidence.** `walletCapabilities.architecture.test.ts`, `walletCapabilities.test.ts`.

**status.** Corregido. M1 deberá cambiar esta política de forma explícita.

### P1 — Resolve Turnstile contract mismatch

**finding.** El backend Welcome Claim podía exigir Turnstile; RMZWallet no sabía si estaba habilitado ni producía token. La UI podía ofrecer `[ Recibir XEC ]` y el backend rechazar cada request.

**root cause.** Contrato partido: Turnstile opcional en faucet, ausente en Quick Start UX.

**fix (menor complejidad, este gate).** Welcome Quick Start requiere `TURNSTILE_ENABLED=false`. Anti-abuso: one-time address + IP/rate limits.

- config pública: `turnstileRequired`, `quickStartCompatible` (solo metadata)
- startup log: `Welcome Quick Start configuration rejected` si Turnstile está on
- `POST /starter-pack` → HTTP 503, sin enviar XEC
- RMZWallet oculta `[ Recibir XEC ]` si `quickStartCompatible=false` / `turnstileRequired=true`
- CORP `cross-origin` para que el wallet con COEP `require-corp` pueda llamar al faucet
- no se integró el widget Turnstile

**tests.** `welcomeQuickStartPolicy.test.ts`, `welcomeFaucet.compatibility.test.ts`, authority match en `welcome.ts` / `index.ts`, config `quickStartCompatible: true` con Turnstile off.

**evidence.** `GET http://127.0.0.1:3015/v1/faucet/starter-pack/config` → `turnstileRequired:false`, `quickStartCompatible:true`, `dryRun:true`. Aceptación: `[ Recibir XEC ]` → `Simulación completada.`

**status.** Corregido para este gate. Integrar Turnstile completo queda fuera.

---

## Validación

Node observado: `v24.19.0` (`>=24.18.0 <25`).

### RMZWallet

```bash
npx tsc -b                         # PASS
npx tsc -p tsconfig.tm1-regtest-e2e.json  # PASS
npm test                           # PASS  2686 vitest / 153 files + 10 slpNftTxBuilder
npx tsx --test src/services/slpNftTxBuilder.test.ts  # PASS 10 (incluido en npm test)
npm run lint                       # FAIL preexistente en BASE
```

`npm test` HEAD: **2686** tests vitest + **10** slp. BASE histórico de este gate era 2674+10; el incremento son tests nuevos de remediación, no recorte de suite.

### Lint diferencial

Clasificación: **FAIL preexistente en BASE**. No es FAIL nuevo en HEAD.

| Checkout | SHA | Resultado |
|---|---|---|
| BASE `/tmp/rmzwallet-tm-comm-a0-base` | `ab0024a97ac62f9ba3725b92c553805cb348c7fb` | `✖ 328 problems (328 errors, 0 warnings)` |
| HEAD worktree | `2050b35e80bda11ed85373284717b08425b77b14` | `✖ 328 problems (328 errors, 0 warnings)` (conteo del pass previo; archivos Quick Start: 0 hits) |

Hits ESLint en archivos Quick Start tocados por este pass: **0**. No se remediò deuda de Tonalli Memo / Agent Wallet / settlement / broadcast / signing / aliasDiscovery / MemoCompose.

Logs: `/tmp/qs-lint-base-stylish.txt`, `/tmp/qs-lint-head-remediation.txt`.

### tonalli-faucet

```bash
npm test           # primer run este pass: 41/41 PASS
npm run typecheck  # PASS
npm run build      # PASS
```

Clasificación del native abort posterior: **fallo ambiental**. `src/routes/faucet.test.ts` ya hace `db.close()` en `after()`; `better-sqlite3` `Statement::~Statement` aborta el isolate de `node --test` en corridas siguientes. Los tests Welcome/Quick Start aislados: **22/22 PASS** (`welcome.test.ts`, `welcome.authority.test.ts`, `welcomeQuickStartPolicy.test.ts`, `rpcConfig.test.ts`). No se tocó el suite de faucet social para maquillar el abort.

---

## Acceptance real (perfil limpio, dry-run, sin fondos reales)

Preview Vercel del PR #99 sigue SSO-gated (`302` a `vercel.com/sso-api`). Se usó dry-run local:

- API: `http://127.0.0.1:3015` (`FAUCET_DRY_RUN=true`, `TURNSTILE_ENABLED=false`, RPC placeholder, sqlite `/tmp/qs-acceptance/welcome-dryrun.sqlite`)
- UI: `http://127.0.0.1:5173` (`VITE_TONALLI_FAUCET_URL=http://127.0.0.1:3015`)
- Navegador: Chromium Playwright persistente, perfil vacío por flujo
- Config faucet: `{"ok":true,"enabled":true,"oneTimePerAddress":true,"dryRun":true,"turnstileRequired":false,"quickStartCompatible":true,"starterPack":{"xecSats":"100000","xec":"1000"}}`

### Flujo 1 — Crear → Welcome dry-run → reload → receive → backup

| Paso | Resultado |
|---|---|
| open Tonalli → Crear mi Tonalli | PASS |
| wallet activa | PASS |
| Welcome XEC dry-run `[ Recibir XEC ]` | PASS `Simulación completada.` |
| reload | PASS **misma address** |
| Recibir | PASS QR + misma address |
| Protege tu Tonalli → backup | PASS; dashboard pasa a `BACKUP_VERIFIED` |
| reload / unlock PIN | PASS misma address `ecash:qrrg57kgq5hr0qzrstwwtqxcpav5gt55ycxukz3uh9` (corrida 2026-09-18T01:06:26Z) |

### Flujo 2 — Chronik no disponible no crea segunda wallet

PASS. Address `ecash:qzl9tml7a2svwnyfzcvqx98u7ppx6dvazgl6d9wu8j` sobrevivió reload con Chronik abortado. `/onboarding/create` mostró el botón **disabled**. Tras el intento, la address original permaneció. El error de balance se mostró como `Error connecting to known Chronik instances` sin borrar la identidad.

### Flujo 3 — Conversation intent persiste

PASS.

```
capture → {"kind":"conversation","peer":"xolos.ramirez","source":"xolosramirez"}
Dashboard → same
reload → same
```

No se usaron fondos reales.

---

## Codex exact-head review

Solicitado otra vez el 2026-09-17T22:54:53Z (`@codex review` en PR #99 y PR #3).

Respuesta `chatgpt-codex-connector[bot]` 2026-09-17T22:55:00Z / 22:55:01Z:

> You have reached your Codex usage limits for code reviews.

**Status:** review externo pendiente. No hay findings de código de Codex sobre el HEAD de implementación. **No se llama al gate completo.**

---

## Residual risks

1. `@codex review` exact-head bloqueado por cuota — **no merge** hasta que exista.
2. Preview Vercel SSO-gated; freeze-audit acceptance was local dry-run.
3. `npm run lint` global sigue en 328 errores históricos (BASE=HEAD, 0 hits Quick Start).
4. Device-local IndexedDB se destruye si el usuario borra datos del sitio antes del backup.
5. Turnstile no está integrado; Quick Start Welcome exige `TURNSTILE_ENABLED=false`.
6. `wallet.initialize()` de Chronik sigue en background tras unlock; no bloquea la identidad local.

---

## Release Candidate Freeze Audit

Freeze date: 2026-09-18. Functional Quick Start/Welcome product code was not redesigned. Faucet received only test-runner stability fixes found by this audit.

### Exact HEADs

| Repo | Role | SHA |
|---|---|---|
| RMZWallet | implementation | `2050b35e80bda11ed85373284717b08425b77b14` |
| RMZWallet | PR tip before this report commit | `23e38bb0d810ee5cc6e0d12f80490d632cef7029` |
| RMZWallet | authoritative tip | `git rev-parse HEAD` |
| tonalli-faucet | implementation / PR tip | `aeb5b2ad4f33f1d09205ea3584f59bfcbb0aae71` |
| tonalli-faucet | Turnstile contract | `4e32338a6aee3411c1d23d0b3257ca18300af841` |

PR metadata on #99 and #3 was updated to these identities. Codex was **not** re-pinged.

### Independent findings

Product audit of RMZWallet `2050b35` and faucet Welcome/Turnstile `4e32338` (code, not the previous report):

- Quick Start overwrite: `storeQuickStartMnemonic` / `persistNonExtractableDeviceKey` fail closed; availability probe uses `PROBE_KEY_RECORD` then deletes it.
- Chronik independence: local identity via `activateMnemonicLocalIdentity`; initialize is background; loadExistingWallet does not wait on balance.
- Bootstrap: hydrator is a no-op; `WalletProvider` owns `pending|absent|recovered|failed`; create blocked while pending/failed.
- Seed: AES-GCM non-extractable key; no mnemonic in URL/storage/network.
- Backup: encrypt → verify → `BACKUP_VERIFIED` → then discard QS.
- `TM_COMM=false` in `isCapabilityAllowed` for all three lifecycles; not in `FULL_WALLET_CAPABILITIES`.
- Intent: Onboarding `readTonalliIntent` only; `consumeTonalliIntent` remains for a future consumer.
- Faucet: `INSERT OR IGNORE` + `failed_retryable` retry only; ambiguous RPC → `needs_review`; no second `POST /starter-pack`; Turnstile-on → 503; CORP cross-origin; RPC secrets sanitized.

```text
Fresh independent audit: P0=0 P1=0 P2=1
```

The P2 was the faucet `node --test` SIGABRT (`Statement::~Statement` → `RemoveEnvironmentCleanupHook` with `env == nullptr`) on Node 24.19.0 + better-sqlite3 11.10.0. It is **not** environmental: reproduced on consecutive clean processes, including `faucet.test.ts` alone (exit 134 with tests already green). Root cause: native statement destructors during isolate teardown. Fix in-repo: drop `db.close()` in `after()` and upgrade to better-sqlite3 **12.9.0**. After the fix, remaining product P2 = 0.

### Faucet test-run stability (committed `aeb5b2a`)

| Run | Command | Result |
|---|---|---|
| 1 | `npm test` clean process | 41/41 PASS, exit 0 |
| 2 | `npm test` clean process | 41/41 PASS, exit 0 |
| 3 | `npm test` clean process | 41/41 PASS, exit 0 |

Before the sqlite upgrade, a 3-run series was 41 / abort / 41. Isolation=none is invalid (shared `fetch` mocks). Concurrency=1 still aborted 11.10.0.

`npm run typecheck` PASS. `npm run build` PASS.

### RMZWallet validation (`2050b35` product / docs tip)

| Check | Result |
|---|---|
| `npx tsc -b` | PASS |
| `npx tsc -p tsconfig.tm1-regtest-e2e.json` | PASS |
| `npm test` | 2686 vitest + 10 slp PASS |
| `npm run lint` HEAD | `✖ 328 problems (328 errors, 0 warnings)` |
| lint BASE `ab0024a` | `✖ 328 problems (328 errors, 0 warnings)` |
| Quick Start lint hits | 0 |

Classification: **FAIL preexistente en BASE**, not a new HEAD finding.

### Clean-profile acceptance (2026-09-18T01:28:03Z)

Local dry-run only (`TURNSTILE_ENABLED=false`, `FAUCET_DRY_RUN=true`). No real funds. Vercel preview still SSO-gated.

| Flow | Result |
|---|---|
| Create → Welcome dry-run → reload same address → Receive → backup → reload → unlock PIN | PASS `ecash:qpkpm5743u75ackmudl22uakkv0ejur8fuyyzkzvsh` |
| Chronik unavailable → same identity → create blocked | PASS `ecash:qzs5nhphp9dpeupvzdzh69elpphd7qu7fvhusxejlt` |
| conversation intent → Dashboard → reload still pending | PASS |

### Codex status

Do not spam. Last attempts:

- 2026-09-17T22:54:53Z PR #99 and #3 → usage limit 22:55:00Z
- 2026-09-18T01:07:48Z PR #99 → usage limit 01:07:55Z

No exact-head Codex findings exist. This independent audit **does not substitute** Codex.

### Final residuals

Codex quota; Vercel SSO; historical ESLint 328; IndexedDB wipe before backup; Turnstile not integrated; Chronik initialize remains background-only.

---

## GO / NO-GO

**GO — ready for merge review.**

Independent audit remaining product: P0=0 P1=0. RMZWallet suites PASS. Faucet suites PASS. Faucet `npm test` 3/3. Clean-profile acceptance PASS. No new security findings.

**Do not merge. Do not deploy production. Do not use real funds until Codex exact-head review completes.**
