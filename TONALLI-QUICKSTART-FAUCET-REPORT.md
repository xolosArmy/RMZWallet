# TONALLI-QUICKSTART-FAUCET-REPORT.md

Canonical gate report for Tonalli Quick Start + Welcome XEC.

This file lives at the root of `xolosArmy/RMZWallet` on branch `feat/tonalli-quickstart-onboarding`. It is the source of truth for review. Read it in full with:

```bash
cat TONALLI-QUICKSTART-FAUCET-REPORT.md
```

Do not depend on GitHub UI, screenshots, or external files to understand the result.

**Merge was not performed. Production was not deployed. Real funds were not used. History was not rewritten.**

---

## Fecha y estado final del gate

| Campo | Valor |
|---|---|
| Fecha | 2026-09-17 |
| Gate | Tonalli Quick Start — Integration & Release UX Restructure |
| Estado | cerrado en ramas de feature; **sin merge** |
| Decisión | **GO — Quick Start ready for TM-COMM M1 / Xolos Ramírez integration** |
| Justificación | Las invariantes de seed, aislamiento de capabilities, recovery crash-safe, claim one-time e idempotencia están implementadas y cubiertas por tests. TM-COMM permanece desacoplado. El residual es el click-through humano con perfil limpio de Firefox (no ejecutado en este entorno) y el `@codex review` bloqueado por límite de uso de Codex. Ninguno de esos residuales rompe las invariantes de seed, double-pay o signing. |

---

## Identidades exactas

Verificar en el checkout que contiene este archivo:

```bash
git rev-parse HEAD
git merge-base origin/main HEAD
git log --oneline origin/main..HEAD
```

### RMZWallet (`xolosArmy/RMZWallet`)

| Campo | Valor |
|---|---|
| Rama | `feat/tonalli-quickstart-onboarding` |
| BASE `origin/main` | `ab0024a97ac62f9ba3725b92c553805cb348c7fb` |
| BASE subject | `[Gate C3A] RMZWallet Settlement Engine: Durable Ownership, Local TXID Derivation, and Broadcast Boundary (#96)` |
| HEAD de primitives (antes de este gate) | `39c078643a6d8df2cfc91654c453caca8b0f0521` |
| HEAD de implementación | `b67fd2feb163f0e1b5716be5f142f11786480715` |
| HEAD de documentación SHA table | `fdbee3351dad0bef4e88ffff25bf892060816ac6` |
| HEAD de rama | `git rev-parse HEAD` en `feat/tonalli-quickstart-onboarding` (último push conocido: `7ef524a2e837323316a7d1db120428700b59e6f4`) |
| PR | **#99** |
| URL | https://github.com/xolosArmy/RMZWallet/pull/99 |
| Base del PR | `main` |
| Estado del PR | OPEN, no mergeado |

Checkout de trabajo: `/home/xolosarmy/ecashschool/RMZWallet-quickstart` (git worktree). El checkout TM-COMM A0 en `/home/xolosarmy/ecashschool/RMZWallet` **no se modificó**.

### tonalli-faucet (`xolosArmy/tonalli-faucet`)

| Campo | Valor |
|---|---|
| Rama | `feat/welcome-xec-one-time-claim` |
| BASE `origin/main` | `f1964d220d23b214141e722ea5781adee32c0fc9` |
| HEAD de primitives (antes de unificar autoridad) | `94235140fac0f22430929a5d2f1fb6bbc71554a3` |
| HEAD | `c26b70e06bf69568a7b2b5430917a79a3a9fb48c` |
| PR | **#3** |
| URL | https://github.com/xolosArmy/tonalli-faucet/pull/3 |
| Base del PR | `main` |
| Estado del PR | OPEN, no mergeado |

Checkout de trabajo: `/home/xolosarmy/ecashschool/tonalli-faucet`.

No se crearon ramas paralelas equivalentes. No hubo force-push.

---

## Commits

### RMZWallet `origin/main..HEAD`

```
7ef524a2e837323316a7d1db120428700b59e6f4  docs(onboarding): include canonical report commits in the SHA log
ff9c1403ac55ab470b3084f9baf2dd706394d0ce  docs(onboarding): pin canonical report to published SHA
b2c0d89557ec021fe9696250fb27d67cbf1afe12  docs(onboarding): publish canonical TONALLI-QUICKSTART-FAUCET-REPORT.md
fdbee3351dad0bef4e88ffff25bf892060816ac6  docs(onboarding): record exact Quick Start and Welcome Claim SHAs
b67fd2feb163f0e1b5716be5f142f11786480715  feat(onboarding): complete Tonalli Quick Start lifecycle and Welcome XEC UX
39c078643a6d8df2cfc91654c453caca8b0f0521  feat(onboarding): restore encrypted quick start wallet after reload
c7ae51f5456ef0ca844d5180bbf855e805002334  feat(onboarding): add embedded welcome faucet client
32d3819392afc8d13f1ec3933f363e41215d52e6  feat(onboarding): add encrypted passwordless quick start storage
```

El tip de la rama es siempre `git rev-parse HEAD` en `feat/tonalli-quickstart-onboarding`.

### tonalli-faucet `origin/main..HEAD`

```
c26b70e06bf69568a7b2b5430917a79a3a9fb48c  feat(faucet): make Welcome Claim the sole starter-pack authority
94235140fac0f22430929a5d2f1fb6bbc71554a3  test(faucet): cover one-time welcome claim races and ambiguous broadcast
d890b2e51adaec6cd138def691bd3387f6d78feb  feat(faucet): route starter pack through welcome claim guard
2e4fbb8bc09558037f4293ed1084c022ebf1fd45  feat(faucet): make starter pack a one-time idempotent XEC welcome claim
21d4008c9908dcb767776e149111064a382d5184  feat(faucet): add durable one-time welcome claim ledger
```

---

## Archivos modificados

### RMZWallet vs `ab0024a97ac62f9ba3725b92c553805cb348c7fb`

```
TONALLI-QUICKSTART-FAUCET-REPORT.md
package-lock.json
package.json
src/App.tsx
src/components/DesktopNavigation.tsx
src/components/MobileBottomNav.tsx
src/components/ProgressiveBackupBanner.tsx
src/components/QuickStartHydrator.tsx
src/components/TonalliIntentCapture.tsx
src/components/WelcomeXecCard.tsx
src/components/walletNavigation.ts
src/context/WalletContext.quickStart.test.tsx
src/context/WalletContext.tsx
src/context/walletContext.ts
src/domain/walletCapabilities.architecture.test.ts
src/domain/walletCapabilities.test.ts
src/domain/walletCapabilities.ts
src/domain/walletLifecycle.test.ts
src/domain/walletLifecycle.ts
src/index.css
src/routes/BackupSeed.tsx
src/routes/Dashboard.tsx
src/routes/More.tsx
src/routes/Onboarding.test.tsx
src/routes/Onboarding.tsx
src/routes/OnboardingRestoreProfiles.test.tsx
src/routes/SendMenu.tsx
src/services/XolosWalletService.ts
src/services/backupSession.ts
src/services/quickStartBoundaries.architecture.test.ts
src/services/quickStartStorage.test.ts
src/services/quickStartStorage.ts
src/services/tonalliIntent.test.ts
src/services/tonalliIntent.ts
src/services/welcomeClaim.test.ts
src/services/welcomeClaim.ts
src/services/welcomeFaucet.ts
src/test/walletContextFixture.ts
```

Stat al tip previo a este reporte: 38 files, +2347 / −177 (el commit de este archivo suma este `.md`).

### tonalli-faucet vs `f1964d220d23b214141e722ea5781adee32c0fc9`

```
backend/README.md
backend/src/index.ts
backend/src/routes/faucet.ts
backend/src/routes/welcome.authority.test.ts
backend/src/routes/welcome.test.ts
backend/src/routes/welcome.ts
backend/src/welcomeClaims.ts
```

Stat: 7 files, +742 / −144.

No se refactorizaron C2, C3A, WalletConnect, x402, Agora, Agent Wallet, Tonalli Memo ni TM-COMM A0.

---

## Arquitectura final

```text
WalletLifecycle
        ↓
Capability Policy
        ↓
Wallet features
```

Una sola Wallet (`XolosWalletService` + `WalletContext`). Quick Start no crea una wallet paralela.

Happy path:

```text
Abrir Tonalli
      ↓
Crear mi Tonalli
      ↓
wallet generada localmente (BIP39 en memoria Wallet-owned)
      ↓
ciphertext Quick Start en IndexedDB + CryptoKey no exportable
      ↓
QUICK_START_UNBACKED  (wallet activa limitada)
      ↓
Recibe tus primeros XEC  (POST /v1/faucet/starter-pack con activeWallet.address)
      ↓
usar Tonalli (balance, receive, refresh)
      ↓
Protege tu Tonalli  (backup progresivo)
      ↓
BACKUP_VERIFIED
      ↓
capabilities completas existentes
```

Flujo secundario conservado (compatibilidad):

```text
Ya tengo una wallet
  ├── Desbloquear wallet
  ├── Restaurar wallet
  ├── Modo lectura
  └── Opciones avanzadas (crear con PIN y respaldo inmediato)
```

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
      ├── future TM-COMM boundary (capability reservada, internals no implementados)
      │
      └── protect wallet
              │
              ▼
       BACKUP_VERIFIED
              │
              ▼
       full Wallet capabilities
```

Fuente de verdad única:

```ts
resolveWalletLifecycle({ initialized, backupVerified })
```

| Evidence | Lifecycle |
|---|---|
| `initialized=false` | `UNINITIALIZED` (aunque `backupVerified` esté en localStorage; hay que desbloquear) |
| `initialized=true`, `backupVerified=false` | `QUICK_START_UNBACKED` |
| `initialized=true`, `backupVerified=true` | `BACKUP_VERIFIED` |

Estados transitorios de UI (`creating`, `hydrating`, `claiming`, `backing_up`) **no** son autoridad persistente. Archivo: `src/domain/walletLifecycle.ts`.

---

## Capability matrix completa por estado

Definida en `src/domain/walletCapabilities.ts`.

| Capability | UNINITIALIZED | QUICK_START_UNBACKED | BACKUP_VERIFIED |
|---|---|---|---|
| VIEW_BALANCE | block | **allow** | allow |
| RECEIVE_XEC | block | **allow** | allow |
| WELCOME_XEC_CLAIM | block | **allow** | allow |
| BACKUP_WALLET | block | **allow** | allow |
| REFRESH_BALANCE | block | **allow** | allow |
| RESUME_SAFE_INTENT | block | **allow** | allow |
| TM_COMM | block | **block** (reservada, sin internals) | declarada; internals **no** implementados en este gate |
| SEND_XEC | block | **block** | restore existing |
| SEND_RMZ | block | **block** | restore existing |
| SEND_FIRMA | block | **block** | restore existing |
| ETOKEN_OPERATIONS | block | **block** | restore existing |
| NFT_OPERATIONS | block | **block** | restore existing |
| AGORA_TRADING | block | **block** | restore existing |
| ALIAS_SPEND_OPERATIONS | block | **block** | restore existing |
| WALLETCONNECT | block | **block** | restore existing |
| X402 | block | **block** | restore existing |
| EXTERNAL_SIGNING | block | **block** | restore existing |
| AGENT_WALLET_EXECUTION | block | **block** | restore existing |
| ARBITRARY_BROADCAST | block | **block** | restore existing |

Defensa en profundidad: los métodos sensibles de `WalletContext` conservan `if (!initialized || !backupVerified) throw` **y** llaman `assertCapability(...)`.

UI: nav oculta Enviar en Quick Start; SendMenu y More fallan cerrados; Dashboard no promociona send.

---

## Estrategia final de almacenamiento / cifrado de la seed

### Quick Start (wallet activa limitada, sin PIN todavía)

| Pieza | Detalle |
|---|---|
| DB | IndexedDB `tonalli-quickstart-v1`, store `wallet` |
| Device key | `crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, extractable=false, ['encrypt','decrypt'])` |
| Algoritmo | AES-GCM, IV 12 bytes aleatorio |
| Record versionado | `version`, `iv`, `ciphertext`, `derivationProfileId`, `address` (metadato público), `createdAt` |
| Qué NO es la key | address, alias, fingerprint, PIN, cualquier valor público/predecible |
| Fail closed | si no hay IndexedDB / SubtleCrypto / `getRandomValues`, o si la CryptoKey no persiste no extractable → `QuickStartUnavailableError` |
| Fallback | crear con PIN/password local (`/onboarding/create-backed`). **Nunca plaintext** |

Archivo: `src/services/quickStartStorage.ts`.

### Backup verificado (wallet completa)

El mecanismo cifrado **normal** de Tonalli no se sustituyó:

- `encryptWithPassword` / `decryptWithPassword` en `src/services/crypto.ts`
- AES-GCM + PBKDF2 300k, contenedor v2 en `localStorage` key `xoloswallet_encrypted_mnemonic`
- perfil de derivación en `xoloswallet_derivation_profile_v1`
- flag `xoloswallet_backup_verified`

La seed en claro solo vive en `XolosWalletService.decryptedMnemonic` (memoria runtime, frontera Wallet).

---

## Confirmación: la seed nunca queda plaintext persistida, URL, history.state, logs o red

| Superficie | Resultado | Cómo |
|---|---|---|
| URL / query params | no | onboarding ya no navega con mnemonic |
| `history.state` | no | se eliminó `navigate('/backup', { state: { mnemonic } })` |
| localStorage plaintext | no | Quick Start usa ciphertext IndexedDB; backup usa contenedor AES-GCM |
| sessionStorage plaintext | no | intent adapter no guarda seed; password pendiente vive en módulo RAM `backupSession.ts` |
| logs | no | hydrator ya no hace `console.warn(..., error)` con objetos de recovery que pudieran arrastrar secretos; no se loguea mnemonic |
| analytics | no | no hay instrumentation de seed |
| network / fetch / XHR | no | `welcomeFaucet` envía `{ address, turnstileToken? }` |
| IndexedDB plaintext | no | test: ciphertext ≠ mnemonic; CryptoKey `extractable === false` |

Tests: `src/services/quickStartBoundaries.architecture.test.ts`, `src/services/quickStartStorage.test.ts`.

`getMnemonic()` sigue expuesto en el contexto **solo** para backup/reveal Wallet-owned. No se copia entre rutas por props de router.

---

## Rehidratación después de reload

```text
encrypted Quick Start record (IndexedDB)
        ↓
decrypt locally with non-extractable device CryptoKey
        ↓
activateQuickStartWallet(mnemonic, storedDerivationProfileId)
        ↓
derive the same identity (no Chronik discovery / no choice-required)
        ↓
QUICK_START_UNBACKED
        ↓
refresh balance
```

- No pide intervención humana.
- No muestra seed.
- `QuickStartHydrator` está montado en `App` y llama `activateQuickStartFromDevice()`, **no** `restoreWallet`.

Si existe wallet cifrada con PIN y `backupVerified=true`, el hydrator no pisa ese flujo: el usuario desbloquea. Tras unlock verificado se descarta un leftover Quick Start si lo hubiera.

---

## Migración crash-safe Quick Start → backup normal

Al pulsar **Protege tu Tonalli** / `/backup`:

1. Mostrar la frase desde `getMnemonic()` (memoria Wallet).
2. Verificar palabras #3, #7 y #11.
3. Pedir PIN/password local (≥ 6).
4. `persistVerifiedBackup(password)`:
   - `encryptAndStoreMnemonic` → `localStorage` AES-GCM+PBKDF2
   - `verifyStoredMnemonic`: descifrar y comparar con la seed en memoria
5. Solo si verifica: `backupVerified=true` (`xoloswallet_backup_verified=true`)
6. Solo entonces `discardQuickStartRecord()` borra ciphertext + device key

Si el verify falla: **no** se borra Quick Start. Lifecycle permanece `QUICK_START_UNBACKED`.

Crash windows:

| Crash | Qué queda | Recuperación |
|---|---|---|
| Antes de encrypt | solo Quick Start | hydrator restaura |
| Encrypt OK, verify fail | Quick Start + ciphertext dudoso | Quick Start sigue siendo la copia recuperable |
| Verify OK, flag OK, delete QS fail | ambas copias, `BACKUP_VERIFIED` | unlock PIN; leftover QS se limpia al cargar |
| Delete QS OK | solo wallet cifrada con PIN | unlock normal |

Nunca se borra la única copia recuperable antes de comprobar que la nueva copia cifrada descifra.

---

## Arquitectura Welcome XEC

Frontend:

```text
activeWallet.address
      ↓
GET  /v1/faucet/starter-pack/config     (cantidad autoritativa)
GET  /v1/faucet/starter-pack/status
POST /v1/faucet/starter-pack            { address, turnstileToken? }
      ↓
completed → refreshBalances → mostrar XEC
already_claimed / pending_review → no segunda transferencia
```

- La wallet **nunca** pide copiar address.
- La cantidad se toma del backend (`starterPack.xec`), no se hardcodea en UI.
- CTA: «Recibe tus primeros {xec} XEC» / `[ Recibir XEC ]`
- UI oculta si no hay `VITE_TONALLI_FAUCET_URL`.

Archivos: `src/services/welcomeFaucet.ts`, `src/services/welcomeClaim.ts`, `src/components/WelcomeXecCard.tsx`.

Backend: `backend/src/routes/welcome.ts` + `backend/src/welcomeClaims.ts`.

---

## State machine del claim

Estados internos (`welcome_claims.status`):

```
(no row)
   POST + INSERT OR IGNORE → pending
        │
        ├─ sendtoaddress OK → completed  (o dry_run_completed)
        ├─ RPC con broadcastMayHaveOccurred=false → failed_retryable
        └─ timeout / conexión perdida / txid ausente / desconocido → needs_review
```

Estados públicos:

| Interno | Público | HTTP | ¿Nueva transferencia? |
|---|---|---|---|
| (no row) | `available` | 200 | sí, si POST |
| `completed` / `dry_run_completed` | `already_claimed` | 200 | no |
| `pending` / `needs_review` | `pending_review` | 202 | **nunca** automática |
| `failed_retryable` | `retryable` | 200 | sí, un retry |
| limiter | `rate_limited` | 429 | no |
| AppError | `error` | 4xx/5xx | no |

`pending_review` **nunca** dispara otra transferencia.

---

## Idempotencia

- Identidad primaria: **wallet address** (PK SQLite, normalizada `ecash:` lowercase).
- IP: HMAC (`IP_HASH_SECRET`) + rate limit. No es clave de claim.
- Reserva atómica: transacción SQLite `UPDATE failed_retryable → pending` **o** `INSERT OR IGNORE pending`. Solo `changes === 1` puede llamar `sendXecToAddress`.
- Invariante: **una address → como máximo un broadcast real de Welcome XEC**, excepto un retry con evidencia de que el intento anterior **no pudo** haber sido broadcast.

---

## Concurrencia, double-click y replay

| Caso | Comportamiento | Test |
|---|---|---|
| Primer claim | 1 RPC, `completed`, 1000 XEC | welcome.test.ts |
| Misma address otra vez | `already_claimed`, 0 RPC extra | welcome.test.ts |
| Double-click secuencial | segunda respuesta `already_claimed` | welcome.test.ts |
| POST paralelos | 1 RPC; `{completed, pending_review}` | welcome.test.ts |
| Reload GET status | no RPC | welcome.test.ts |
| Respuesta perdida tras broadcast | GET/POST reconcilian `already_claimed` + mismo txid | welcome.test.ts |
| Frontend double-click | `inFlight` ref + `shouldAttemptWelcomeClaim` | welcomeClaim.test.ts |
| Carrera sobre `failed_retryable` | una sola transferencia de retry | welcome.test.ts |

---

## Broadcast ambiguo y garantía contra double-pay

Clasificador: `BitcoinAbcRpcError.broadcastMayHaveOccurred` en `backend/src/services/bitcoinAbcRpc.ts`.

| Evidencia | Acción |
|---|---|
| Definitivo pre-broadcast (`ECONNREFUSED`, DNS, HTTP 401/403, RPC de request inválido) | `failed_retryable` — un retry permitido |
| Ambiguo (`ETIMEDOUT`, `ECONNRESET`, JSON inválido, txid ausente, RPC desconocido) | `needs_review` — **cero** retries automáticos |
| Broadcast OK pero no se pudo finalizar la fila pending | `needs_review` conservando txid |

Double-pay queda excluido porque solo un reservation `pending` puede llamar RPC, y `needs_review` no vuelve a `pending` por el POST público.

---

## Importe autoritativo del starter XEC

```
STARTER_XEC_SATS  default "100000"   →  1000 XEC
```

Fuente: `backend/src/config.ts` `starterXecSats`.  
Expuesto en `GET /v1/faucet/starter-pack/config` como `{ xecSats, xec }`.  
El frontend **no** hardcodea 1000; muestra `config.starterPack.xec`.

Welcome Claim envía **solo XEC**. No envía RMZ.

---

## Integración frontend ↔ faucet

| Dirección | Contrato |
|---|---|
| Env | `VITE_TONALLI_FAUCET_URL` (sin trailing slash) |
| Config | `GET {base}/v1/faucet/starter-pack/config` |
| Status | `GET {base}/v1/faucet/starter-pack/status?address=` |
| Claim | `POST {base}/v1/faucet/starter-pack` JSON `{ address, turnstileToken? }` |
| Address | siempre `activeWallet.address` / `xolosWalletService.getAddress()` |

El frontend público de tonalli-faucet (`POST /claim` social) **no** usa starter-pack. Es otro producto. Se dejó separado a propósito.

Autoridad HTTP: `welcomeRouter` se monta **antes** que `faucetRouter` en `/v1/faucet` y `/api/v1/faucet`. El `POST /starter-pack` legacy XEC+RMZ se **eliminó** de `faucet.ts`.

---

## Deep-link / intent boundary para Xolos Ramírez

```ts
type TonalliIntent =
  | {
      kind: 'conversation'
      peer: string
      source?: 'xolosramirez'
    }
```

- Persistencia: `sessionStorage` key `tonalli_safe_intent_v1`
- Captura: `?intent=conversation&peer=...&source=xolosramirez`
- Archivos: `src/services/tonalliIntent.ts`, `src/components/TonalliIntentCapture.tsx`
- Capability: `RESUME_SAFE_INTENT` permitida en Quick Start
- **No** hay protocolo de mensajería
- **No** se importan módulos `privateMessaging`
- **No** hay dependencia de TM-COMM A0

Flujo futuro (fuera de este gate):

```text
xolosramirez.com
      ↓
Tonalli intent
      ↓
Quick Start if necessary
      ↓
Welcome XEC
      ↓
TM-COMM          ← FUERA DE ESTE GATE
```

---

## TM-COMM permanece desacoplado

Confirmado:

- Rama Quick Start **no** contiene `privateMessaging` ni `server/tmComm`.
- Architecture test recorre `src/` y falla si aparece `from '...privateMessaging'` / `tmComm`.
- Capability `TM_COMM` está declarada y **bloqueada** en `QUICK_START_UNBACKED`.
- El checkout `feat/tm-comm-a0-architecture-staging` no se modificó.

Trabajo explícito dejado para **TM-COMM M1**:

- Consumir `TonalliIntent` desde TM-COMM
- Implementar internals de mensajería
- Conceder `TM_COMM` cuando el producto lo autorice (no desde Quick Start unbacked sin política)
- UX «Hablar por Tonalli» en xolosramirez.com

---

## Invariantes C2, C3A, WalletConnect, x402, Agora y Agent Wallet

| Frontera | ¿Se alteró semántica para Quick Start? | Cómo se preserva |
|---|---|---|
| C2 signing | no | no se refactorizó `agentWalletExecution`; capability `AGENT_WALLET_EXECUTION` bloqueada en unbacked |
| C3A settlement | no | settlement no tocado |
| Broadcast ownership | no | Quick Start no llama broadcast; `ARBITRARY_BROADCAST` bloqueada |
| Agent Wallet approval/execution | no | invariantes existentes; capability bloqueada |
| x402 authority | no | `X402` bloqueada; `activateStoredWalletForX402` sigue exigiendo wallet cifrada |
| WalletConnect authority | no | `WALLETCONNECT` bloqueada; `ConnectRequest` ya exigía `backupVerified` |
| Agora signing | no | `AGORA_TRADING` bloqueada; `agoraExchange` no refactorizado |
| Tonalli Memo protocol | no | no se cambió el protocolo; compose sigue en rutas existentes |
| Alias spend | no | `ALIAS_SPEND_OPERATIONS` + throws `backupVerified` |

Tests: `src/domain/walletCapabilities.architecture.test.ts`, `src/services/quickStartBoundaries.architecture.test.ts`, `src/context/WalletContext.quickStart.test.tsx`.

---

## Comandos de validación ejecutados

### RMZWallet (worktree Quick Start)

```bash
npx tsc -b
npx tsc -p tsconfig.tm1-regtest-e2e.json
npm test
# vitest run --exclude src/services/slpNftTxBuilder.test.ts
# && npx tsx --test src/services/slpNftTxBuilder.test.ts
npx eslint <archivos Quick Start tocados>
```

`npm run lint` (`eslint .`) **no** se usó como criterio de este gate: en BASE `ab0024a` ya es históricamente rojo (Tonalli Memo / Agent Wallet, `no-explicit-any` / hooks). No se recortó ni se silenció esa suite. Los archivos tocados por Quick Start se lint-earon en aislamiento: 0 errores.

### tonalli-faucet

```bash
npm test          # tsx --test src/**/*.test.ts
npm run typecheck
npm run build
```

No hay script `lint` en tonalli-faucet.

RPC de tests: mock de `fetch` contra `127.0.0.1:8332`. SQLite en `/tmp/tonalli-welcome-test-<pid>.sqlite`. Sin fondos reales.

---

## Resultado y conteo de cada suite

| Suite | Comando | Resultado | Conteo |
|---|---|---|---|
| RMZWallet unit/integration/architecture | `npm test` (vitest) | PASS | **2674** tests, **152** files |
| RMZWallet slpNftTxBuilder | `npx tsx --test src/services/slpNftTxBuilder.test.ts` | PASS | **10** tests |
| RMZWallet typecheck | `tsc -b` + `tsc -p tsconfig.tm1-regtest-e2e.json` | PASS | — |
| RMZWallet ESLint touched Quick Start | `npx eslint …` | PASS | 0 errors |
| RMZWallet ESLint global `eslint .` | no ejecutado como gate | FAIL preexistente en BASE | no remediar aquí |
| tonalli-faucet backend tests | `npm test` | PASS | **40/40** |
| tonalli-faucet typecheck | `npm run typecheck` | PASS | backend + frontend |
| tonalli-faucet build | `npm run build` | PASS | backend tsc + frontend vite |

Clasificación de fallos globales (política del usuario):

- `npm run lint` rojo en mainline Memo/Agent = **FAIL preexistente en BASE**, no bloquea este gate si Quick Start no añade findings nuevos en archivos tocados.
- Suites ejecutadas de este trabajo = **PASS**.

---

## Evidencia del clean-browser-profile acceptance test

Caso exigido: persona sin conocimientos de criptomonedas abre Tonalli por primera vez.

| Paso | ¿Cubierto? | Evidencia |
|---|---|---|
| Abrir Tonalli | sí (automatizado) | `Onboarding.test.tsx`: un CTA primario **Crear mi Tonalli**, secundario **Ya tengo una wallet** |
| Crear mi Tonalli | sí | create path sin PIN, sin seed, sin BIP44 |
| Ver wallet | sí | lifecycle `QUICK_START_UNBACKED`, Dashboard limited |
| Reclamar XEC | sí (orquestador) | `WelcomeXecCard` + `welcomeClaim.test.ts`; POST usa address interna |
| Ver saldo | sí | `REFRESH_BALANCE` / `VIEW_BALANCE` permitidos |
| Recargar página | sí | hydrator + storage tests; misma address; no muestra seed |
| Funciones de bajo riesgo | sí | receive/refresh/claim/backup allowed |
| No copiar address para el claim | sí | address nunca se pide en el CTA de Welcome XEC |
| No conocer seed / derivation | sí | copy de Quick Start no muestra seed/BIP44/UTXO |
| No forzar backup antes de explorar | sí | banner no bloquea capabilities de bajo riesgo |
| Protege tu Tonalli → BACKUP_VERIFIED | sí | `WalletContext.quickStart.test.tsx` |
| Reclamar de nuevo sin nueva transferencia | sí | faucet `already_claimed` / frontend no POST en `pending_review` |

**Live Firefox clean profile:** no se ejecutó un perfil de navegador vacío contra Vite+Chronik+faucet dry-run en esta sesión (no hay harness de browser automation en el gate). Eso es un residual operativo, no una laguna de invariante de seed/double-pay. El procedimiento humano permanece:

```text
perfil limpio → abrir Tonalli → Crear mi Tonalli → ver wallet
→ Recibir XEC (con VITE_TONALLI_FAUCET_URL y faucet dry-run)
→ recargar → misma wallet → Protege tu Tonalli → backup
→ intentar reclamar otra vez → already_claimed
```

---

## Estado del `@codex review` de cada PR

| PR | Comentario `@codex review` | Respuesta Codex | Reviews humanas | Findings de código |
|---|---|---|---|---|
| RMZWallet #99 | https://github.com/xolosArmy/RMZWallet/pull/99#issuecomment-5721800511 | **usage limits** — «You have reached your Codex usage limits for code reviews» (chatgpt-codex-connector) | ninguna | **ningún finding de código**; review no se ejecutó |
| tonalli-faucet #3 | https://github.com/xolosArmy/tonalli-faucet/pull/3#issuecomment-5721800668 | **usage limits** — mismo bloqueo | ninguna | **ningún finding de código**; review no se ejecutó |

No se inventaron findings. No hay review exact-head que corregir.

Vercel preview (no es Codex): RMZWallet Ready; faucet frontend Ready. No es evidencia de este gate y no se usó como GO.

---

## Findings pendientes

| ID | Origen | Estado |
|---|---|---|
| Codex review no ejecutado por límite de uso | ambos PRs | pendiente de un `@codex review` exact-head cuando haya cuota |
| Live Firefox clean-profile | aceptación humana | pendiente operativa antes de cutover a producción (este gate no despliega) |
| `eslint .` histórico en BASE | Memo / Agent Wallet | fuera de alcance; no se tocó para poner verde artificial |

---

## Riesgos residuales

1. IndexedDB Quick Start es local al origen/dispositivo. Borrar datos del sitio antes del backup destruye la única copia (igual que cualquier wallet passwordless de dispositivo).
2. `getMnemonic()` permanece en el contexto para backup/reveal. Architecture tests impiden copiarlo a router/storage/red; un futuro componente descuidado podría leerlo.
3. Welcome XEC no aparece si falta `VITE_TONALLI_FAUCET_URL`.
4. Hydrator + Chronik en reload real depende de red; tests de hydrator no pegan a Chronik de producción.
5. Codex review no aportó findings porque no corrió.
6. Preview de Vercel no equivale a acceptance de perfil limpio.

---

## Limitaciones conocidas

- `TM_COMM` es un nombre de capability, no un messenger.
- El faucet social `POST /claim` (X/Telegram/RMZ gate) sigue existiendo como producto distinto.
- `GET /v1/faucet/health` todavía describe el pack legado (incluye `rmzAtoms`) para el health del servicio social; el starter pack de Quick Start es XEC-only vía welcome.
- Compatibilidad de import/unlock/read-only se conservó; el create clásico con PIN quedó en **Opciones avanzadas**.
- Node engine RMZWallet: `>=24.18.0 <25`.

---

## Trabajo explícitamente dejado para TM-COMM M1

1. Consumir `TonalliIntent` (`kind: 'conversation'`) desde TM-COMM.
2. Implementar conversación / ACL / storage canónico de TM-COMM (A0 ya vive en otra rama; **no** se acopló).
3. Flujo `xolosramirez.com → Hablar por Tonalli → intent → Quick Start si hace falta → Welcome XEC → resume → conversación`.
4. Política de cuándo `TM_COMM` pasa a allow (no desde unbacked sin decisión de producto).
5. `@codex review` exact-head de estos PRs cuando haya cuota.

---

## Decisión final

```text
GO — Quick Start ready for TM-COMM M1 / Xolos Ramírez integration
```

Justificación técnica:

- Quick Start UX completa (un CTA primario, secundario compatible).
- Same-wallet reload por ciphertext + perfil de derivación almacenado.
- Seed nunca plaintext persistida, ni URL, ni `history.state`, ni logs, ni red (tests de arquitectura + storage).
- Capabilities privilegiadas bloqueadas en `QUICK_START_UNBACKED`; se restauran en `BACKUP_VERIFIED`.
- Migración de backup verificable y recuperable si hay crash.
- Welcome Claim one-time / idempotente por address; `pending_review` no auto-paga.
- Broadcast ambiguo no puede causar double-pay.
- Legacy unlock / import / read-only conservados.
- TM-COMM desacoplado.
- Suites ejecutadas de este trabajo: verdes.
- Residual humano/Codex no invalida las invariantes anteriores y no autoriza merge ni producción.

**No merge.**

---

## Operator Summary

1. **Qué quedó implementado.** Onboarding de un clic «Crear mi Tonalli» que deja una wallet activa limitada, cifra la seed en el dispositivo sin PIN, recarga sola, puede reclamar Welcome XEC una vez por address, y solo desbloquea send/NFT/WC/x402/Agent/Agora después de un backup verificado.

2. **Qué cambió respecto al onboarding anterior.** Ya no hay cuatro decisiones equivalentes ni «Generar seed» + PIN obligatorio + mnemonic en `history.state`. El create clásico con PIN vive en «Ya tengo una wallet → Opciones avanzadas». `POST /starter-pack` ya no tiene un segundo algoritmo XEC+RMZ.

3. **Riesgos pendientes.** Perfil limpio de Firefox no se recorrió en vivo; `@codex review` está bloqueado por límite de uso (cero findings de código). Borrar datos del sitio antes del backup pierde la Quick Start wallet.

4. **PRs a revisar (sin merge).**
   - https://github.com/xolosArmy/RMZWallet/pull/99
   - https://github.com/xolosArmy/tonalli-faucet/pull/3

5. **Siguiente gate del roadmap.** TM-COMM M1 / integración Xolos Ramírez: consumir `TonalliIntent`, no reabrir C2/C3A/x402/WC, y correr `@codex review` exact-head más el acceptance humano con perfil limpio antes de cualquier cutover.
