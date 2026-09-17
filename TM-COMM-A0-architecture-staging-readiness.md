# TM-COMM A0 — Architecture & Staging Readiness

Evidencia A0. Scope estrictamente TM-COMM. **No se remedió el lint global histórico de RMZWallet.**

**No merge. No producción. No clientes reales. No OpenAI. No fondos reales.**

Fecha de verificación lint diferencial y suites: 2026-09-17.

---

## Identidad

| Campo | Valor |
| --- | --- |
| Repositorio | `xolosArmy/RMZWallet` |
| Rama | `feat/tm-comm-a0-architecture-staging` |
| **BASE SHA** (origen de la rama = `origin/main` canónico) | `ab0024a97ac62f9ba3725b92c553805cb348c7fb` |
| Mensaje BASE | `[Gate C3A] RMZWallet Settlement Engine: Durable Ownership, Local TXID Derivation, and Broadcast Boundary (#96)` |
| SHA implementación A0 | `006ac8f0f1bc6d7dedfe95ece54c9ebb94e0171f` |
| **HEAD SHA** al momento de lint diferencial / typecheck / build / tests | `8070f991d556e7c5369906652a77c2a848bb9a97` |
| Mensaje HEAD | `docs(tm-comm): record A0 architecture and staging evidence` |
| PR / merge | **No se abrió PR. No se hizo merge.** |

Anclaje:

```bash
git fetch origin main
git rev-parse origin/main
# ab0024a97ac62f9ba3725b92c553805cb348c7fb
git checkout -B feat/tm-comm-a0-architecture-staging origin/main
```

Lint BASE se ejecutó en worktree desacoplado en exactamente `ab0024a97ac62f9ba3725b92c553805cb348c7fb`, no sobre un SHA supuesto.

---

## Veredicto

**GO para iniciar M0.**

A0 no introduce ningún error nuevo de lint. `npm run lint` es **BASELINE FAILURE / PRE-EXISTING** en BASE y en HEAD: **328 errores en ambos**. Cero errores en archivos TM-COMM. Cero errores en archivos modificados por A0.

No se declara PASS el lint global.

---

## Staging URL

| Superficie | URL | Resultado |
| --- | --- | --- |
| API | http://127.0.0.1:4178/v1/tm-comm/health | `{"ok":true,"environment":"staging","protocol":"tm-comm","version":1,"financialAuthority":false,"memoPublication":false}` |
| UI | http://127.0.0.1:5174/tm-comm-staging | HTTP 200 |
| API vía proxy Vite | http://127.0.0.1:5174/tm-comm-api/v1/tm-comm/health | mismo JSON |

Procesos: `npm run tm-comm:staging` y `VITE_TM_COMM_STAGING=true npx vite --host 127.0.0.1 --port 5174 --strictPort`.

DB y secrets independientes: `.tmp/tm-comm-staging/` (gitignored). Reservas ficticias `rsv_staging_client_a` y `rsv_staging_client_b`.

---

## Archivos modificados (BASE → HEAD)

```text
M  .env.example
A  TM-COMM-A0-architecture-staging-readiness.md
A  docs/tm-comm/README.md
A  docs/tm-comm/a0-ai-agent-boundary.md
A  docs/tm-comm/a0-architecture.md
A  docs/tm-comm/a0-email-fallback.md
A  docs/tm-comm/a0-staging.md
A  docs/tm-comm/a0-threat-model.md
A  docs/tm-comm/a0-tonalli-memo-boundary.md
M  package.json
A  scripts/tm-comm-staging-up.ts
A  server/tmComm/* (store, HTTP, auth, schema, tests)
M  src/App.tsx
M  src/components/walletNavigation.ts
A  src/config/tmCommStaging.ts
A  src/features/privateMessaging/*
M  src/routes/More.tsx
A  src/routes/TmCommStaging.tsx
A  src/routes/TmCommStaging.test.tsx
A  src/routes/tmCommStagingClient.ts
M  vite.config.ts
```

Agent Wallet, settlement, broadcast, signing productivo y Tonalli Memo **no se modificaron** para limpiar lint.

---

## Modelo de datos

| Entidad | Rol |
| --- | --- |
| `Principal` | Identidad de servidor tras challenge. Una address conocida no es autoridad. |
| `ReservationBinding` | Principal ↔ reserva ficticia. Solo con token de enrolamiento de Xolos Ramírez. |
| `Conversation` | Un hilo por reserva (cliente bindeado + operador). |
| `Message` | Mensaje privado durable. |
| `MessageReceipt` | `delivered` / `read` por principal. |
| `AuditEvent` | allow/deny sin cuerpos ni secretos. |

`Message` mínimo: `id` (servidor), `clientMessageId` (idempotente), `conversationId`, `senderPrincipalId`, `senderKind`, `body`, `serverCreatedAt` (servidor), `replyToId` opcional, `status` ∈ {`accepted`,`delivered`,`read`}.

Registro canónico: SQLite (`node:sqlite`, WAL). `localStorage` no es fuente de verdad.

---

## Auth challenge

Protocolo `TM-COMM-AUTH-V1`. **No** es `/connect/sign-message`.

1. Servidor emite nonce de un solo uso, expiración, audience/origin, session context.
2. Tonalli firma el string canónico con `signMessage`. Las claves no salen de Tonalli.
3. Servidor verifica address, pubkey, firma, nonce no usado, expiración, origin/audience, session context.
4. Cookie HttpOnly `SameSite=Strict`. La sesión **no** abre reservas.
5. Binding exige token de enrolamiento. `reservationId`/`customerId`/`conversationId`/`walletAddress` del navegador son claims.

---

## Prueba A/B de aislamiento

`server/tmComm/tmComm.http.test.ts` → `client A cannot read, list, send as, or touch metadata of client B`.

A no puede: listar conversación de B; leer mensajes de B; enviar como B; escribir en B; obtener adjuntos/metadata de B; escapar ACL cambiando ids en URL/body.

Denegaciones 403 + audit: `CONVERSATION_FORBIDDEN`, `SENDER_IMPERSONATION`, `ATTACHMENT_UNAVAILABLE`, `RESERVATION_CLAIM_MISMATCH`.

Una address autenticada sin token tiene `bindings: []` y `conversations: []`.

---

## Persistencia después de reload

Mismo test file → `accepted messages survive store reopen and support receipts plus idempotency`.

Mensaje aceptado → close store + HTTP → reopen SQLite → GET con la misma cookie → el mensaje permanece con el mismo id de servidor. `clientMessageId` es idempotente. Receipts `delivered`/`read` soportados.

---

## Resultados de tests (HEAD `8070f99`)

| Comando | Exit | Resultado | Clasificación |
| --- | --- | --- | --- |
| `npm run typecheck` | 0 | `tsc -b && tsc -p tsconfig.tm1-regtest-e2e.json` limpio | PASS |
| `npm run build` | 0 | Vite 7.3.0, 1419 modules, 39–45s. Warnings de eval/chunk/browserslist (preexistentes de deps) | PASS con warnings de build |
| `npx vitest run src/features/privateMessaging server/tmComm src/routes/TmCommStaging.test.tsx` | 0 | **5 files / 22 tests pass** (incluye architecture boundaries) | PASS |
| Architecture boundaries | 0 | `privateMessaging.architecture.test.ts` **8/8** | PASS |
| `npm test` (suite vigente) | 0 | pretest Node 24.19.0; vitest **149 files / 2670 pass**; tsx slpNft **10/10 pass** | PASS |
| `npm run lint` BASE | 1 | **328 errors, 0 warnings** | **BASELINE FAILURE / PRE-EXISTING** |
| `npm run lint` HEAD | 1 | **328 errors, 0 warnings** | **BASELINE FAILURE / PRE-EXISTING** (idéntico conteo; 0 regresiones A0) |

Tests TM-COMM 22:

- `privateMessaging.domain.test.ts` (4)
- `privateMessaging.architecture.test.ts` (8) — frontera: no signing/keys/settlement/broadcast/`sendXec`/`sendETokens`/Memo/`agentWalletExecution`
- `tmComm.auth.test.ts` (3)
- `tmComm.http.test.ts` (5) — health, no-authority-from-address, nonce, A/B, durabilidad
- `TmCommStaging.test.tsx` (2)

Stderr en suite vigente (tests que **pasan**; no omitidos):

```text
stderr | src/routes/RegisterAlias.test.tsx ... QuotaExceededError: storage is full
stderr | src/services/XolosWalletService.x402Activation.test.ts
WebAssembly initialization failed (using fallbacks): Cannot find module './browser-shims/ecash_lib_wasm_browser'
```

---

## Tabla lint BASE vs HEAD

Comando idéntico en ambos: `npm run lint` (`eslint .`).

| Métrica | BASE `ab0024a97ac62f9ba3725b92c553805cb348c7fb` | HEAD `8070f991d556e7c5369906652a77c2a848bb9a97` |
| --- | --- | --- |
| Exit code | 1 | 1 |
| Problems | 328 errors, 0 warnings | 328 errors, 0 warnings |
| Fixable | 2 | 2 |
| Errores en archivos TM-COMM | 0 | 0 |
| Errores en archivos tocados por A0 (`App.tsx`, `More.tsx`, `walletNavigation.ts`, `vite.config.ts`, `package.json`, `.env.example`) | 0 | 0 |
| Errores nuevos introducidos por A0 | — | **0** |
| Errores presentes ya en BASE | 328 | 328 (los mismos fingerprints `file:line:col:rule`) |
| Errores fuera de scope | 328 | 328 |
| Clasificación | BASELINE FAILURE / PRE-EXISTING | BASELINE FAILURE / PRE-EXISTING |

Fingerprints únicos `file:line:col:rule`: 327 en ambos (una línea de `react-hooks/refs` se reporta más de una vez; el total ESLint es 328).  
ONLY_HEAD = 0. ONLY_BASE = 0.

La diferencia binaria de logs es solo padding de columnas stylish de ESLint (worktree vs repo). No hay reglas, archivos ni líneas nuevas.

**Regresión A0 de lint: ninguna.** No se corrigió código TM-COMM en esta pasada porque no había errores nuevos que corregir.

---

## Fallos preexistentes (BASELINE FAILURE / PRE-EXISTING)

Todos los 328 viven fuera de TM-COMM: Tonalli Memo, Agent Wallet Execution, Trusted Wallet Runtime, MemoCompose, aliasDiscovery. **No se tocaron.**

| Archivo | Errores | Clasificación | Scope |
| --- | --- | --- | --- |
| `src/integrations/tonalliMemo/tm1RegtestE2eHarness.test.ts` | 139 | BASELINE FAILURE / PRE-EXISTING | fuera de scope |
| `src/features/agentWalletExecution/agentWalletExecution.architecture.test.ts` | 57 | BASELINE FAILURE / PRE-EXISTING | fuera de scope |
| `src/features/agentWalletExecution/settlement.test.ts` | 30 | BASELINE FAILURE / PRE-EXISTING | fuera de scope |
| `src/features/agentWalletExecution/agentWalletExecution.test.ts` | 29 | BASELINE FAILURE / PRE-EXISTING | fuera de scope |
| `src/internal/agentWalletExecutionHost/trustedWalletExecutionRuntime.tsx` | 22 | BASELINE FAILURE / PRE-EXISTING | fuera de scope |
| `src/components/tonalliMemo/useTm1PublishMachine.test.tsx` | 17 | BASELINE FAILURE / PRE-EXISTING | fuera de scope |
| `src/components/tonalliMemo/useTm1PublishMachine.ts` | 9 | BASELINE FAILURE / PRE-EXISTING | fuera de scope |
| `src/context/WalletContext.aliasPersistence.test.tsx` | 4 | BASELINE FAILURE / PRE-EXISTING | fuera de scope |
| `src/services/aliasDiscovery.ts` | 4 | BASELINE FAILURE / PRE-EXISTING | fuera de scope |
| `src/components/tonalliMemo/TonalliMemoComposer.tsx` | 3 | BASELINE FAILURE / PRE-EXISTING | fuera de scope |
| `src/internal/agentWalletExecutionHost/TrustedWalletExecutionProvider.test.tsx` | 2 | BASELINE FAILURE / PRE-EXISTING | fuera de scope |
| `src/components/tonalliMemo/walletPublisherRecoveryStore.ts` | 2 | BASELINE FAILURE / PRE-EXISTING | fuera de scope |
| `src/features/agentWalletExecution/types.ts` | 2 | BASELINE FAILURE / PRE-EXISTING | fuera de scope |
| `src/services/aliasDiscovery.test.ts` | 2 | BASELINE FAILURE / PRE-EXISTING | fuera de scope |
| `src/components/tonalliMemo/walletPublisherRecoveryStore.test.ts` | 1 | BASELINE FAILURE / PRE-EXISTING | fuera de scope |
| `src/features/agentWalletExecution/errors.ts` | 1 | BASELINE FAILURE / PRE-EXISTING | fuera de scope |
| `src/integrations/tonalliMemo/tm1RegtestE2eHarness.ts` | 1 | BASELINE FAILURE / PRE-EXISTING | fuera de scope |
| `src/internal/agentWalletExecutionHost/TrustedWalletExecutionProvider.tsx` | 1 | BASELINE FAILURE / PRE-EXISTING | fuera de scope |
| `src/routes/MemoCompose.test.tsx` | 1 | BASELINE FAILURE / PRE-EXISTING | fuera de scope |
| `src/routes/MemoCompose.tsx` | 1 | BASELINE FAILURE / PRE-EXISTING | fuera de scope |
| **Total** | **328** | BASELINE FAILURE / PRE-EXISTING | fuera de scope |

Reglas dominantes (HEAD = BASE): `@typescript-eslint/no-explicit-any`, `react-hooks/refs`, `@typescript-eslint/no-unused-vars`, `prefer-const`, `react-refresh/only-export-components`, `no-empty`, `react-hooks/globals`.

Salida completa de HEAD en el Apéndice A. No se declara PASS.

---

## Cualquier regresión A0

| Área | ¿Regresión A0? |
| --- | --- |
| Lint (errores nuevos) | **No** (0) |
| Lint en archivos TM-COMM | **No** (0) |
| Lint en archivos tocados por A0 | **No** (0) |
| Typecheck | No |
| Build | No (exit 0) |
| Tests TM-COMM / architecture | No (22/22) |
| Suite vigente | No (2680 pass) |
| Agent Wallet / Memo / settlement / broadcast / signing | No modificados |

---

## Riesgos residuales

- Tokens de enrolamiento staging en `.tmp/` (secretos de máquina).
- Cookie HttpOnly en HTTP local sin `Secure`.
- Challenge plaintext; no debe incluir contenido de reserva.
- Sin rate-limit en A0.
- XSS en origen staging podría pedir firma de un challenge fresco a Tonalli desbloqueada.
- Operador es fixture, no identidad hardware.
- Email (M1) e IA no implementados; no habilitar send/email sin repetir aislamiento.
- Lint global 328 permanece como deuda **fuera de A0**.

---

## GO / NO-GO para M0

**GO para M0** si se permanece en esta rama, con datos ficticios, sin merge, sin OpenAI, sin email real, sin Memo, sin fondos reales.

**NO-GO** para merge, producción, clientes reales, o para tratar `npm run lint` global como PASS.

Condiciones: M0 sobre este ACL y SQLite. No `localStorage` canónico. No `/connect/sign-message`. No Agent Wallet. No limpiar lint histórico de Memo/Agent Wallet como parte de TM-COMM.

---

## Apéndice A — `npm run lint` HEAD (BASELINE FAILURE / PRE-EXISTING)

Comando: `npm run lint`  
SHA: `8070f991d556e7c5369906652a77c2a848bb9a97`  
Exit 1. 328 errors. Idéntico conteo que BASE `ab0024a97ac62f9ba3725b92c553805cb348c7fb`.


````text

> rmzwallet@0.0.0 lint
> eslint .


/home/xolosarmy/ecashschool/RMZWallet/src/components/tonalliMemo/TonalliMemoComposer.tsx
  132:42  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  133:50  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  134:64  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

/home/xolosarmy/ecashschool/RMZWallet/src/components/tonalliMemo/useTm1PublishMachine.test.tsx
  318:67  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  357:47  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  369:53  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  409:12  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  414:47  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  463:12  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  468:47  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  510:65  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  537:12  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  542:47  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  553:53  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  564:53  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  611:47  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  640:37  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  654:47  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  694:47  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  739:47  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

/home/xolosarmy/ecashschool/RMZWallet/src/components/tonalliMemo/useTm1PublishMachine.ts
   50:51  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   56:54  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   98:15  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  296:39  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  297:39  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  311:44  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  317:20  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  348:34  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  349:31  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

/home/xolosarmy/ecashschool/RMZWallet/src/components/tonalliMemo/walletPublisherRecoveryStore.test.ts
  309:45  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

/home/xolosarmy/ecashschool/RMZWallet/src/components/tonalliMemo/walletPublisherRecoveryStore.ts
  370:43  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  527:54  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

/home/xolosarmy/ecashschool/RMZWallet/src/context/WalletContext.aliasPersistence.test.tsx
   33:18  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   95:39  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   99:73  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  100:25  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

/home/xolosarmy/ecashschool/RMZWallet/src/features/agentWalletExecution/agentWalletExecution.architecture.test.ts
   41:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   42:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   43:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   44:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   45:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   46:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   47:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   48:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   51:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   52:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   55:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   56:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   57:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   58:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   59:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   60:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   63:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   64:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   65:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   66:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   69:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   70:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   71:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   72:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   73:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   74:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   75:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   76:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   77:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   78:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   79:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   80:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   81:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   82:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   83:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   84:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   87:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   88:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   89:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   90:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   91:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   94:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   95:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   96:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  107:29  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  108:29  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  111:72  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  138:24  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  165:29  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  166:29  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  167:29  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  168:29  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  434:28  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  435:28  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  436:28  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  437:28  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  439:24  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

/home/xolosarmy/ecashschool/RMZWallet/src/features/agentWalletExecution/agentWalletExecution.test.ts
   153:23  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   156:21  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   213:29  error  '_address' is defined but never used            @typescript-eslint/no-unused-vars
   223:24  error  '_address' is defined but never used            @typescript-eslint/no-unused-vars
   460:31  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   461:31  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   462:31  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   463:31  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   464:31  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   465:31  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   466:31  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   467:31  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   493:23  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   496:29  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   610:23  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   611:23  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   612:23  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   613:23  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   616:24  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   617:24  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   618:24  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   638:29  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   639:29  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   642:32  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   643:32  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   644:32  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   851:36  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
  1767:9   error  'now' is never reassigned. Use 'const' instead  prefer-const
  1854:9   error  'now' is never reassigned. Use 'const' instead  prefer-const

/home/xolosarmy/ecashschool/RMZWallet/src/features/agentWalletExecution/errors.ts
  71:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

/home/xolosarmy/ecashschool/RMZWallet/src/features/agentWalletExecution/settlement.test.ts
  1039:19  error  '_executionId' is defined but never used            @typescript-eslint/no-unused-vars
  1039:50  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  1159:68  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  1169:29  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  1177:32  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  1178:33  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  1179:33  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  1735:13  error  'txCalls' is assigned a value but never used        @typescript-eslint/no-unused-vars
  1796:28  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  1797:28  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  1798:28  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  1799:28  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  1800:28  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  1801:28  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  1802:28  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  1803:28  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  1804:28  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  1805:28  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  1841:51  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  3469:13  error  'txCalls' is assigned a value but never used        @typescript-eslint/no-unused-vars
  3476:22  error  '_txid' is defined but never used                   @typescript-eslint/no-unused-vars
  3606:17  error  'engineA' is never reassigned. Use 'const' instead  prefer-const
  3661:30  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  3738:17  error  'engineA' is never reassigned. Use 'const' instead  prefer-const
  3793:30  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  3913:13  error  'engineA' is never reassigned. Use 'const' instead  prefer-const
  3928:30  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  3999:33  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  4036:13  error  'engineA' is never reassigned. Use 'const' instead  prefer-const
  4051:30  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any

/home/xolosarmy/ecashschool/RMZWallet/src/features/agentWalletExecution/types.ts
  228:42  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  228:49  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

/home/xolosarmy/ecashschool/RMZWallet/src/integrations/tonalliMemo/tm1RegtestE2eHarness.test.ts
   544:21  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   545:29  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   555:24  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   556:25  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   563:38  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   582:21  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   583:29  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   594:24  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   595:25  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   602:38  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   624:25  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   625:42  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   626:39  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   628:49  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   629:43  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   630:33  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   631:44  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   644:42  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   666:25  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   667:42  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   668:39  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   670:49  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   671:43  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   672:33  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   673:44  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   674:41  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   684:42  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   706:25  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   707:42  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   708:45  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   711:26  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   715:49  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   716:43  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   717:33  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   723:42  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   745:25  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   746:42  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   747:45  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   749:37  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   751:28  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   759:49  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   760:43  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   761:33  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   767:42  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   786:21  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   787:23  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   788:24  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   789:31  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   805:38  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   824:21  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   825:23  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   826:24  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   827:31  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   843:38  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   863:21  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   864:23  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   865:24  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   866:31  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   886:38  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   911:25  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   912:42  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   913:39  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   915:55  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   916:22  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   925:43  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   926:33  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   932:42  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   957:25  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   958:42  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   959:39  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   961:55  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   964:26  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   967:43  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   968:33  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   974:42  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  1981:14  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  1988:14  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  1995:14  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2002:14  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2068:59  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2110:59  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2432:18  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2503:18  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2583:38  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2584:73  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2585:67  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2596:22  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2597:24  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2598:31  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2602:32  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2606:30  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2611:59  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2653:22  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2654:24  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2655:31  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2661:26  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2662:30  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2667:59  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2917:25  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2918:42  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2919:39  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2920:49  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2921:43  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2922:33  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2930:41  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2952:41  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2976:65  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3005:67  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3034:69  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3073:20  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3081:30  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3082:30  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3083:30  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3084:30  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3095:25  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3096:42  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3097:39  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3098:49  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3099:43  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3100:33  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3113:41  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3159:25  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3160:42  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3161:39  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3162:49  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3163:43  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3164:33  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3188:63  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3196:39  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3239:25  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3240:42  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3241:39  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3242:49  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3243:43  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3244:33  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3246:50  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3247:41  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3249:63  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3262:43  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

/home/xolosarmy/ecashschool/RMZWallet/src/integrations/tonalliMemo/tm1RegtestE2eHarness.ts
  158:15  error  Empty block statement  no-empty

/home/xolosarmy/ecashschool/RMZWallet/src/internal/agentWalletExecutionHost/TrustedWalletExecutionProvider.test.tsx
  291:7   error  Error: Cannot reassign variables declared outside of the component/hook

Variable `captured` is declared outside of the component/hook. Reassigning this value during render is a form of side effect, which can cause unpredictable behavior depending on when the component happens to re-render. If this variable is used in rendering, use useState instead. Otherwise, consider updating it in an effect. (https://react.dev/reference/rules/components-and-hooks-must-be-pure#side-effects-must-run-outside-of-render).

/home/xolosarmy/ecashschool/RMZWallet/src/internal/agentWalletExecutionHost/TrustedWalletExecutionProvider.test.tsx:291:7
  289 |     let captured: unknown
  290 |     function Probe() {
> 291 |       captured = useTrustedWalletExecution()
      |       ^^^^^^^^ `captured` cannot be reassigned
  292 |       return null
  293 |     }
  294 |     const ledgerStorage = new MockStorage()  react-hooks/globals
  437:23  error  Unexpected any. Specify a different type                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           @typescript-eslint/no-explicit-any

/home/xolosarmy/ecashschool/RMZWallet/src/internal/agentWalletExecutionHost/TrustedWalletExecutionProvider.tsx
  10:3  error  Fast refresh only works when a file only exports components. Use a new file to share constants or functions between components  react-refresh/only-export-components

/home/xolosarmy/ecashschool/RMZWallet/src/internal/agentWalletExecutionHost/trustedWalletExecutionRuntime.tsx
   210:29  error  Unexpected any. Specify a different type                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   @typescript-eslint/no-explicit-any
   247:29  error  Unexpected any. Specify a different type                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   @typescript-eslint/no-explicit-any
   263:34  error  Unexpected any. Specify a different type                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   @typescript-eslint/no-explicit-any
   914:17  error  '_' is assigned a value but never used                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     @typescript-eslint/no-unused-vars
   981:32  error  Unexpected any. Specify a different type                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   @typescript-eslint/no-explicit-any
  1077:34  error  Unexpected any. Specify a different type                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   @typescript-eslint/no-explicit-any
  1533:86  error  Unexpected any. Specify a different type                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   @typescript-eslint/no-explicit-any
  1691:40  error  Unexpected any. Specify a different type                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   @typescript-eslint/no-explicit-any
  1710:54  error  Unexpected any. Specify a different type                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   @typescript-eslint/no-explicit-any
  2217:28  error  Unexpected any. Specify a different type                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   @typescript-eslint/no-explicit-any
  2217:54  error  Unexpected any. Specify a different type                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   @typescript-eslint/no-explicit-any
  2270:41  error  Unexpected any. Specify a different type                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   @typescript-eslint/no-explicit-any
  2270:73  error  Unexpected any. Specify a different type                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   @typescript-eslint/no-explicit-any
  2693:19  error  Fast refresh only works when a file only exports components. Use a new file to share constants or functions between components                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             react-refresh/only-export-components
  2763:17  error  Fast refresh only works when a file only exports components. Use a new file to share constants or functions between components                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             react-refresh/only-export-components
  2865:20  error  Error: Cannot access refs during render

React refs are values that are not needed for rendering. Refs should only be accessed outside of render, such as in event handlers or effects. Accessing a ref value (the `current` property) during render can cause your component not to update as expected (https://react.dev/reference/react/useRef).

/home/xolosarmy/ecashschool/RMZWallet/src/internal/agentWalletExecutionHost/trustedWalletExecutionRuntime.tsx:2865:20
  2863 |
  2864 |   const compositionRef = useRef<WalletExecutionComposition | null>(null)
> 2865 |   if (c2Enabled && compositionRef.current === null) {
       |                    ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ Cannot access ref value during render
  2866 |     compositionRef.current = getOrCreateShell(
  2867 |       {
  2868 |         approvalLedger: resolvedApprovalLedger!,  react-hooks/refs
  2887:23  error  Error: Cannot access refs during render

React refs are values that are not needed for rendering. Refs should only be accessed outside of render, such as in event handlers or effects. Accessing a ref value (the `current` property) during render can cause your component not to update as expected (https://react.dev/reference/react/useRef).

/home/xolosarmy/ecashschool/RMZWallet/src/internal/agentWalletExecutionHost/trustedWalletExecutionRuntime.tsx:2887:23
  2885 |     )
  2886 |   }
> 2887 |   const composition = compositionRef.current
       |                       ^^^^^^^^^^^^^^^^^^^^^^ Cannot access ref value during render
  2888 |
  2889 |   const [session, setSession] = useState<WalletExecutionReviewSession | null>(null)
  2890 |   const [controller, setController] = useState<WalletLocalConfirmationController | null>(null)     react-hooks/refs
  2887:23  error  Error: Cannot access refs during render

React refs are values that are not needed for rendering. Refs should only be accessed outside of render, such as in event handlers or effects. Accessing a ref value (the `current` property) during render can cause your component not to update as expected (https://react.dev/reference/react/useRef).

/home/xolosarmy/ecashschool/RMZWallet/src/internal/agentWalletExecutionHost/trustedWalletExecutionRuntime.tsx:2887:23
  2885 |     )
  2886 |   }
> 2887 |   const composition = compositionRef.current
       |                       ^^^^^^^^^^^^^^^^^^^^^^ Cannot access ref value during render
  2888 |
  2889 |   const [session, setSession] = useState<WalletExecutionReviewSession | null>(null)
  2890 |   const [controller, setController] = useState<WalletLocalConfirmationController | null>(null)     react-hooks/refs
  2887:23  error  Error: Cannot access refs during render

React refs are values that are not needed for rendering. Refs should only be accessed outside of render, such as in event handlers or effects. Accessing a ref value (the `current` property) during render can cause your component not to update as expected (https://react.dev/reference/react/useRef).

/home/xolosarmy/ecashschool/RMZWallet/src/internal/agentWalletExecutionHost/trustedWalletExecutionRuntime.tsx:2887:23
  2885 |     )
  2886 |   }
> 2887 |   const composition = compositionRef.current
       |                       ^^^^^^^^^^^^^^^^^^^^^^ Cannot access ref value during render
  2888 |
  2889 |   const [session, setSession] = useState<WalletExecutionReviewSession | null>(null)
  2890 |   const [controller, setController] = useState<WalletLocalConfirmationController | null>(null)     react-hooks/refs
  2917:21  error  Error: Cannot access refs during render

React refs are values that are not needed for rendering. Refs should only be accessed outside of render, such as in event handlers or effects. Accessing a ref value (the `current` property) during render can cause your component not to update as expected (https://react.dev/reference/react/useRef).

/home/xolosarmy/ecashschool/RMZWallet/src/internal/agentWalletExecutionHost/trustedWalletExecutionRuntime.tsx:2917:21
  2915 |   const contextValue = useMemo<TrustedWalletExecutionContextValue>(
  2916 |     () => ({
> 2917 |       publicEngine: composition?.publicEngine ?? null
       |                     ^^^^^^^^^^^^^^^^^^^^^^^^^ Cannot access ref value during render
  2918 |     }),
  2919 |     [composition]
  2920 |   )                                                                         react-hooks/refs
  2917:21  error  Error: Cannot access refs during render

React refs are values that are not needed for rendering. Refs should only be accessed outside of render, such as in event handlers or effects. Accessing a ref value (the `current` property) during render can cause your component not to update as expected (https://react.dev/reference/react/useRef).

/home/xolosarmy/ecashschool/RMZWallet/src/internal/agentWalletExecutionHost/trustedWalletExecutionRuntime.tsx:2917:21
  2915 |   const contextValue = useMemo<TrustedWalletExecutionContextValue>(
  2916 |     () => ({
> 2917 |       publicEngine: composition?.publicEngine ?? null
       |                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ Cannot access ref value during render
  2918 |     }),
  2919 |     [composition]
  2920 |   )                                                                 react-hooks/refs
  2934:52  error  Error: Cannot access refs during render

React refs are values that are not needed for rendering. Refs should only be accessed outside of render, such as in event handlers or effects. Accessing a ref value (the `current` property) during render can cause your component not to update as expected (https://react.dev/reference/react/useRef).

/home/xolosarmy/ecashschool/RMZWallet/src/internal/agentWalletExecutionHost/trustedWalletExecutionRuntime.tsx:2934:52
  2932 |
  2933 |   return (
> 2934 |     <TrustedWalletExecutionContext.Provider value={contextValue}>
       |                                                    ^^^^^^^^^^^^ Cannot access ref value during render
  2935 |       {children}
  2936 |       {bound && session && controller ? (
  2937 |         <AgentExecutionReviewModal                                                 react-hooks/refs

/home/xolosarmy/ecashschool/RMZWallet/src/routes/MemoCompose.test.tsx
  490:73  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

/home/xolosarmy/ecashschool/RMZWallet/src/routes/MemoCompose.tsx
  49:24  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

/home/xolosarmy/ecashschool/RMZWallet/src/services/aliasDiscovery.test.ts
  195:69  error  '_pageSize' is defined but never used     @typescript-eslint/no-unused-vars
  289:94  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

/home/xolosarmy/ecashschool/RMZWallet/src/services/aliasDiscovery.ts
  124:19  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  125:19  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  221:40  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  221:63  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

✖ 328 problems (328 errors, 0 warnings)
  2 errors and 0 warnings potentially fixable with the `--fix` option.
````

## Apéndice B — `npm run lint` BASE (worktree `ab0024a`)

Mismo comando. Paths del worktree `/tmp/rmzwallet-tm-comm-a0-base/`. Conteo 328. Clasificación: BASELINE FAILURE / PRE-EXISTING.

````text

> rmzwallet@0.0.0 lint
> eslint .


/tmp/rmzwallet-tm-comm-a0-base/src/components/tonalliMemo/TonalliMemoComposer.tsx
  132:42  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  133:50  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  134:64  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

/tmp/rmzwallet-tm-comm-a0-base/src/components/tonalliMemo/useTm1PublishMachine.test.tsx
  318:67  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  357:47  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  369:53  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  409:12  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  414:47  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  463:12  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  468:47  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  510:65  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  537:12  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  542:47  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  553:53  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  564:53  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  611:47  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  640:37  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  654:47  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  694:47  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  739:47  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

/tmp/rmzwallet-tm-comm-a0-base/src/components/tonalliMemo/useTm1PublishMachine.ts
   50:51  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   56:54  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   98:15  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  296:39  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  297:39  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  311:44  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  317:20  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  348:34  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  349:31  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

/tmp/rmzwallet-tm-comm-a0-base/src/components/tonalliMemo/walletPublisherRecoveryStore.test.ts
  309:45  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

/tmp/rmzwallet-tm-comm-a0-base/src/components/tonalliMemo/walletPublisherRecoveryStore.ts
  370:43  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  527:54  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

/tmp/rmzwallet-tm-comm-a0-base/src/context/WalletContext.aliasPersistence.test.tsx
   33:18  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   95:39  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   99:73  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  100:25  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

/tmp/rmzwallet-tm-comm-a0-base/src/features/agentWalletExecution/agentWalletExecution.architecture.test.ts
   41:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   42:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   43:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   44:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   45:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   46:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   47:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   48:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   51:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   52:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   55:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   56:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   57:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   58:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   59:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   60:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   63:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   64:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   65:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   66:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   69:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   70:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   71:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   72:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   73:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   74:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   75:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   76:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   77:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   78:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   79:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   80:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   81:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   82:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   83:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   84:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   87:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   88:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   89:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   90:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   91:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   94:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   95:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   96:36  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  107:29  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  108:29  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  111:72  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  138:24  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  165:29  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  166:29  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  167:29  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  168:29  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  434:28  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  435:28  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  436:28  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  437:28  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  439:24  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

/tmp/rmzwallet-tm-comm-a0-base/src/features/agentWalletExecution/agentWalletExecution.test.ts
   153:23  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   156:21  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   213:29  error  '_address' is defined but never used            @typescript-eslint/no-unused-vars
   223:24  error  '_address' is defined but never used            @typescript-eslint/no-unused-vars
   460:31  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   461:31  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   462:31  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   463:31  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   464:31  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   465:31  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   466:31  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   467:31  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   493:23  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   496:29  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   610:23  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   611:23  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   612:23  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   613:23  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   616:24  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   617:24  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   618:24  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   638:29  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   639:29  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   642:32  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   643:32  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   644:32  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
   851:36  error  Unexpected any. Specify a different type        @typescript-eslint/no-explicit-any
  1767:9   error  'now' is never reassigned. Use 'const' instead  prefer-const
  1854:9   error  'now' is never reassigned. Use 'const' instead  prefer-const

/tmp/rmzwallet-tm-comm-a0-base/src/features/agentWalletExecution/errors.ts
  71:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

/tmp/rmzwallet-tm-comm-a0-base/src/features/agentWalletExecution/settlement.test.ts
  1039:19  error  '_executionId' is defined but never used            @typescript-eslint/no-unused-vars
  1039:50  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  1159:68  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  1169:29  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  1177:32  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  1178:33  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  1179:33  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  1735:13  error  'txCalls' is assigned a value but never used        @typescript-eslint/no-unused-vars
  1796:28  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  1797:28  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  1798:28  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  1799:28  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  1800:28  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  1801:28  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  1802:28  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  1803:28  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  1804:28  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  1805:28  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  1841:51  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  3469:13  error  'txCalls' is assigned a value but never used        @typescript-eslint/no-unused-vars
  3476:22  error  '_txid' is defined but never used                   @typescript-eslint/no-unused-vars
  3606:17  error  'engineA' is never reassigned. Use 'const' instead  prefer-const
  3661:30  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  3738:17  error  'engineA' is never reassigned. Use 'const' instead  prefer-const
  3793:30  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  3913:13  error  'engineA' is never reassigned. Use 'const' instead  prefer-const
  3928:30  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  3999:33  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any
  4036:13  error  'engineA' is never reassigned. Use 'const' instead  prefer-const
  4051:30  error  Unexpected any. Specify a different type            @typescript-eslint/no-explicit-any

/tmp/rmzwallet-tm-comm-a0-base/src/features/agentWalletExecution/types.ts
  228:42  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  228:49  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

/tmp/rmzwallet-tm-comm-a0-base/src/integrations/tonalliMemo/tm1RegtestE2eHarness.test.ts
   544:21  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   545:29  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   555:24  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   556:25  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   563:38  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   582:21  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   583:29  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   594:24  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   595:25  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   602:38  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   624:25  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   625:42  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   626:39  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   628:49  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   629:43  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   630:33  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   631:44  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   644:42  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   666:25  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   667:42  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   668:39  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   670:49  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   671:43  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   672:33  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   673:44  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   674:41  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   684:42  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   706:25  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   707:42  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   708:45  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   711:26  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   715:49  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   716:43  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   717:33  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   723:42  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   745:25  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   746:42  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   747:45  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   749:37  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   751:28  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   759:49  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   760:43  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   761:33  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   767:42  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   786:21  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   787:23  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   788:24  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   789:31  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   805:38  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   824:21  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   825:23  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   826:24  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   827:31  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   843:38  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   863:21  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   864:23  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   865:24  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   866:31  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   886:38  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   911:25  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   912:42  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   913:39  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   915:55  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   916:22  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   925:43  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   926:33  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   932:42  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   957:25  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   958:42  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   959:39  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   961:55  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   964:26  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   967:43  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   968:33  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   974:42  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  1981:14  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  1988:14  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  1995:14  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2002:14  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2068:59  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2110:59  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2432:18  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2503:18  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2583:38  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2584:73  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2585:67  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2596:22  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2597:24  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2598:31  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2602:32  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2606:30  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2611:59  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2653:22  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2654:24  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2655:31  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2661:26  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2662:30  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2667:59  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2917:25  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2918:42  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2919:39  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2920:49  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2921:43  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2922:33  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2930:41  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2952:41  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2976:65  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3005:67  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3034:69  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3073:20  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3081:30  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3082:30  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3083:30  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3084:30  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3095:25  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3096:42  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3097:39  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3098:49  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3099:43  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3100:33  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3113:41  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3159:25  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3160:42  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3161:39  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3162:49  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3163:43  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3164:33  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3188:63  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3196:39  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3239:25  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3240:42  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3241:39  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3242:49  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3243:43  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3244:33  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3246:50  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3247:41  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3249:63  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3262:43  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

/tmp/rmzwallet-tm-comm-a0-base/src/integrations/tonalliMemo/tm1RegtestE2eHarness.ts
  158:15  error  Empty block statement  no-empty

/tmp/rmzwallet-tm-comm-a0-base/src/internal/agentWalletExecutionHost/TrustedWalletExecutionProvider.test.tsx
  291:7   error  Error: Cannot reassign variables declared outside of the component/hook

Variable `captured` is declared outside of the component/hook. Reassigning this value during render is a form of side effect, which can cause unpredictable behavior depending on when the component happens to re-render. If this variable is used in rendering, use useState instead. Otherwise, consider updating it in an effect. (https://react.dev/reference/rules/components-and-hooks-must-be-pure#side-effects-must-run-outside-of-render).

/tmp/rmzwallet-tm-comm-a0-base/src/internal/agentWalletExecutionHost/TrustedWalletExecutionProvider.test.tsx:291:7
  289 |     let captured: unknown
  290 |     function Probe() {
> 291 |       captured = useTrustedWalletExecution()
      |       ^^^^^^^^ `captured` cannot be reassigned
  292 |       return null
  293 |     }
  294 |     const ledgerStorage = new MockStorage()  react-hooks/globals
  437:23  error  Unexpected any. Specify a different type                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    @typescript-eslint/no-explicit-any

/tmp/rmzwallet-tm-comm-a0-base/src/internal/agentWalletExecutionHost/TrustedWalletExecutionProvider.tsx
  10:3  error  Fast refresh only works when a file only exports components. Use a new file to share constants or functions between components  react-refresh/only-export-components

/tmp/rmzwallet-tm-comm-a0-base/src/internal/agentWalletExecutionHost/trustedWalletExecutionRuntime.tsx
   210:29  error  Unexpected any. Specify a different type                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            @typescript-eslint/no-explicit-any
   247:29  error  Unexpected any. Specify a different type                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            @typescript-eslint/no-explicit-any
   263:34  error  Unexpected any. Specify a different type                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            @typescript-eslint/no-explicit-any
   914:17  error  '_' is assigned a value but never used                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              @typescript-eslint/no-unused-vars
   981:32  error  Unexpected any. Specify a different type                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            @typescript-eslint/no-explicit-any
  1077:34  error  Unexpected any. Specify a different type                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            @typescript-eslint/no-explicit-any
  1533:86  error  Unexpected any. Specify a different type                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            @typescript-eslint/no-explicit-any
  1691:40  error  Unexpected any. Specify a different type                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            @typescript-eslint/no-explicit-any
  1710:54  error  Unexpected any. Specify a different type                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            @typescript-eslint/no-explicit-any
  2217:28  error  Unexpected any. Specify a different type                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            @typescript-eslint/no-explicit-any
  2217:54  error  Unexpected any. Specify a different type                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            @typescript-eslint/no-explicit-any
  2270:41  error  Unexpected any. Specify a different type                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            @typescript-eslint/no-explicit-any
  2270:73  error  Unexpected any. Specify a different type                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            @typescript-eslint/no-explicit-any
  2693:19  error  Fast refresh only works when a file only exports components. Use a new file to share constants or functions between components                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      react-refresh/only-export-components
  2763:17  error  Fast refresh only works when a file only exports components. Use a new file to share constants or functions between components                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      react-refresh/only-export-components
  2865:20  error  Error: Cannot access refs during render

React refs are values that are not needed for rendering. Refs should only be accessed outside of render, such as in event handlers or effects. Accessing a ref value (the `current` property) during render can cause your component not to update as expected (https://react.dev/reference/react/useRef).

/tmp/rmzwallet-tm-comm-a0-base/src/internal/agentWalletExecutionHost/trustedWalletExecutionRuntime.tsx:2865:20
  2863 |
  2864 |   const compositionRef = useRef<WalletExecutionComposition | null>(null)
> 2865 |   if (c2Enabled && compositionRef.current === null) {
       |                    ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ Cannot access ref value during render
  2866 |     compositionRef.current = getOrCreateShell(
  2867 |       {
  2868 |         approvalLedger: resolvedApprovalLedger!,  react-hooks/refs
  2887:23  error  Error: Cannot access refs during render

React refs are values that are not needed for rendering. Refs should only be accessed outside of render, such as in event handlers or effects. Accessing a ref value (the `current` property) during render can cause your component not to update as expected (https://react.dev/reference/react/useRef).

/tmp/rmzwallet-tm-comm-a0-base/src/internal/agentWalletExecutionHost/trustedWalletExecutionRuntime.tsx:2887:23
  2885 |     )
  2886 |   }
> 2887 |   const composition = compositionRef.current
       |                       ^^^^^^^^^^^^^^^^^^^^^^ Cannot access ref value during render
  2888 |
  2889 |   const [session, setSession] = useState<WalletExecutionReviewSession | null>(null)
  2890 |   const [controller, setController] = useState<WalletLocalConfirmationController | null>(null)     react-hooks/refs
  2887:23  error  Error: Cannot access refs during render

React refs are values that are not needed for rendering. Refs should only be accessed outside of render, such as in event handlers or effects. Accessing a ref value (the `current` property) during render can cause your component not to update as expected (https://react.dev/reference/react/useRef).

/tmp/rmzwallet-tm-comm-a0-base/src/internal/agentWalletExecutionHost/trustedWalletExecutionRuntime.tsx:2887:23
  2885 |     )
  2886 |   }
> 2887 |   const composition = compositionRef.current
       |                       ^^^^^^^^^^^^^^^^^^^^^^ Cannot access ref value during render
  2888 |
  2889 |   const [session, setSession] = useState<WalletExecutionReviewSession | null>(null)
  2890 |   const [controller, setController] = useState<WalletLocalConfirmationController | null>(null)     react-hooks/refs
  2887:23  error  Error: Cannot access refs during render

React refs are values that are not needed for rendering. Refs should only be accessed outside of render, such as in event handlers or effects. Accessing a ref value (the `current` property) during render can cause your component not to update as expected (https://react.dev/reference/react/useRef).

/tmp/rmzwallet-tm-comm-a0-base/src/internal/agentWalletExecutionHost/trustedWalletExecutionRuntime.tsx:2887:23
  2885 |     )
  2886 |   }
> 2887 |   const composition = compositionRef.current
       |                       ^^^^^^^^^^^^^^^^^^^^^^ Cannot access ref value during render
  2888 |
  2889 |   const [session, setSession] = useState<WalletExecutionReviewSession | null>(null)
  2890 |   const [controller, setController] = useState<WalletLocalConfirmationController | null>(null)     react-hooks/refs
  2917:21  error  Error: Cannot access refs during render

React refs are values that are not needed for rendering. Refs should only be accessed outside of render, such as in event handlers or effects. Accessing a ref value (the `current` property) during render can cause your component not to update as expected (https://react.dev/reference/react/useRef).

/tmp/rmzwallet-tm-comm-a0-base/src/internal/agentWalletExecutionHost/trustedWalletExecutionRuntime.tsx:2917:21
  2915 |   const contextValue = useMemo<TrustedWalletExecutionContextValue>(
  2916 |     () => ({
> 2917 |       publicEngine: composition?.publicEngine ?? null
       |                     ^^^^^^^^^^^^^^^^^^^^^^^^^ Cannot access ref value during render
  2918 |     }),
  2919 |     [composition]
  2920 |   )                                                                         react-hooks/refs
  2917:21  error  Error: Cannot access refs during render

React refs are values that are not needed for rendering. Refs should only be accessed outside of render, such as in event handlers or effects. Accessing a ref value (the `current` property) during render can cause your component not to update as expected (https://react.dev/reference/react/useRef).

/tmp/rmzwallet-tm-comm-a0-base/src/internal/agentWalletExecutionHost/trustedWalletExecutionRuntime.tsx:2917:21
  2915 |   const contextValue = useMemo<TrustedWalletExecutionContextValue>(
  2916 |     () => ({
> 2917 |       publicEngine: composition?.publicEngine ?? null
       |                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ Cannot access ref value during render
  2918 |     }),
  2919 |     [composition]
  2920 |   )                                                                 react-hooks/refs
  2934:52  error  Error: Cannot access refs during render

React refs are values that are not needed for rendering. Refs should only be accessed outside of render, such as in event handlers or effects. Accessing a ref value (the `current` property) during render can cause your component not to update as expected (https://react.dev/reference/react/useRef).

/tmp/rmzwallet-tm-comm-a0-base/src/internal/agentWalletExecutionHost/trustedWalletExecutionRuntime.tsx:2934:52
  2932 |
  2933 |   return (
> 2934 |     <TrustedWalletExecutionContext.Provider value={contextValue}>
       |                                                    ^^^^^^^^^^^^ Cannot access ref value during render
  2935 |       {children}
  2936 |       {bound && session && controller ? (
  2937 |         <AgentExecutionReviewModal                                                 react-hooks/refs

/tmp/rmzwallet-tm-comm-a0-base/src/routes/MemoCompose.test.tsx
  490:73  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

/tmp/rmzwallet-tm-comm-a0-base/src/routes/MemoCompose.tsx
  49:24  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

/tmp/rmzwallet-tm-comm-a0-base/src/services/aliasDiscovery.test.ts
  195:69  error  '_pageSize' is defined but never used     @typescript-eslint/no-unused-vars
  289:94  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

/tmp/rmzwallet-tm-comm-a0-base/src/services/aliasDiscovery.ts
  124:19  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  125:19  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  221:40  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  221:63  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

✖ 328 problems (328 errors, 0 warnings)
  2 errors and 0 warnings potentially fixable with the `--fix` option.
````
