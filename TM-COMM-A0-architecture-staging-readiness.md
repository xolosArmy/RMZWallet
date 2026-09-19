# TM-COMM A0 — Architecture & Staging Readiness

Scope: TM-COMM A0 only. **No se remedió el lint histórico de RMZWallet.** No merge.

---

## Identidad

| Campo | SHA / valor |
| --- | --- |
| Repositorio | `xolosArmy/RMZWallet` |
| Rama | `feat/tm-comm-a0-architecture-staging` |
| **BASE SHA** | `ab0024a97ac62f9ba3725b92c553805cb348c7fb` |
| BASE worktree | `/tmp/rmzwallet-tm-comm-a0-base` |
| Mensaje BASE | `[Gate C3A] RMZWallet Settlement Engine: Durable Ownership, Local TXID Derivation, and Broadcast Boundary (#96)` |
| **PASS 1 REVIEWED HEAD** | `0aef01d195bc4bbe15d564ab6187e65356365d17` |
| **PASS 1 REMEDIATION SHA** | `09e3d946e346cb58a3ef2e176cc8e12e7327e035` |
| **PASS 2 REVIEWED HEAD** | `a63aeacc6a407517805c4c2c31a351511281600c` |
| **PASS 2 REMEDIATION SHA** | `ee5d2ad07e48e0b94c76eebf9d568e6dbe1cf7dd` |
| **NEW FINAL HEAD** | Exact HEAD of `feat/tm-comm-a0-architecture-staging` (PR #98 remediation pass 2 closure) |
| Staging API | http://127.0.0.1:4178/v1/tm-comm/health |
| Staging UI | http://127.0.0.1:5174/tm-comm-staging |
| Estado | **READY FOR FRESH CODEX REVIEW** |
| Merge | **No** |

> [!NOTE]
> **Aclaración de Genealogía y Corrección de SHA**: Se documenta explícitamente que la referencia previa `a63aeacef335ca7f42dcae2e83b8b64e6224168e` correspondió a una referencia errónea en notas. El commit HEAD remoto canónico de PR #98 efectivamente revisado por Codex para el Pass 2 fue `a63aeacc6a407517805c4c2c31a351511281600c`.

---

## Remediation Pass 2 (Codex Findings P2-5 & P2-6)

El fresh Codex review ejecutado sobre el exact HEAD `a63aeacc6a407517805c4c2c31a351511281600c` identificó 2 findings P2 adicionales. Ambos han sido formalmente remediados en `ee5d2ad07e48e0b94c76eebf9d568e6dbe1cf7dd` conservando todas las remediaciones P2 previas y las invariantes de arquitectura de TM-COMM A0:

### P2-5: Pin the expected session context before signing (`PRRC_kwDOQYWUus7xmxqu` / Thread `PRRT_kwDOQYWUus6kAPHV`)
- **Causa raíz**: En la validación del challenge de autenticación (`verifyAndReconstructAuthChallenge`), se verificaba la presencia sintáctica de `sessionContext` y su coincidencia con `canonicalMessage`, pero el valor provenía exclusivamente del payload untrusted enviado por el servidor. Esto permitía que un servidor malicioso o desalineado indujera a la wallet a firmar para un contexto de sesión arbitrario que la wallet no esperaba.
- **Remediación**:
  - Se definió y exportó la constante canónica `TM_COMM_EXPECTED_SESSION_CONTEXT = 'tm-comm-a0-staging:v1'` en `src/features/privateMessaging/authChallenge.ts` y re-exportó en `src/features/privateMessaging/index.ts`.
  - Se reutilizó dicha constante en `server/tmComm/tmCommConfig.ts` (`TM_COMM_SESSION_CONTEXT = TM_COMM_EXPECTED_SESSION_CONTEXT`) para garantizar consistencia entre cliente y servidor sin duplicación frágil de strings.
  - Se extendió `TmCommAuthChallengeValidationOptions` con `expectedSessionContext?: string` (por defecto `TM_COMM_EXPECTED_SESSION_CONTEXT`).
  - En `verifyAndReconstructAuthChallenge`, se exige de forma fail-closed que `payload.sessionContext === expectedSessionContext`. Ante cualquier discrepancia, cadena vacía, versión distinta o whitespace, se arroja un error inmediato.
  - En la UI de staging (`src/routes/TmCommStaging.tsx`), se pasa explícitamente `expectedSessionContext: TM_COMM_EXPECTED_SESSION_CONTEXT`. Ante cualquier error de validación, se aborta y jamás se invoca `xolosWalletService.signMessage`.
- **Archivos modificados**:
  - `src/features/privateMessaging/authChallenge.ts`
  - `src/features/privateMessaging/index.ts`
  - `server/tmComm/tmCommConfig.ts`
  - `src/routes/TmCommStaging.tsx`
- **Tests agregados/actualizados**:
  - `src/features/privateMessaging/privateMessaging.domain.test.ts` (8 nuevos tests unitarios en la suite `P2-5 sessionContext pinning` verificando: exact match permitido; contexto foráneo rechazado; prefijo con versión distinta rechazado; contexto vacío rechazado; contexto omitido rechazado; whitespace rechazado; canonicalMessage consistente con contexto alterado rechazado; opciones con expectedSessionContext inválido rechazadas).
  - `src/routes/TmCommStaging.test.tsx` (6 nuevos casos en la suite paramétrica de challenge inválido confirmando que un challenge con context erróneo, version mismatch, context vacío, context omitido o whitespace resulta en fail-closed con 0 llamadas a `signMessage`).

### P2-6: Include replyToId in idempotency identity with replay vs conflict semantics (`PRRC_kwDOQYWUus7xmxqx` / Thread `PRRT_kwDOQYWUus6kAPHX`)
- **Causa raíz**: El endpoint `sendMessage` en `server/tmComm/tmCommService.ts` evaluaba la idempotencia de mensajes comparando únicamente `existing.senderPrincipalId !== principal.id` y `existing.body !== body`. El campo semántico `replyToId` quedaba fuera de la tupla de identidad. Por ende, un reintento con el mismo `clientMessageId` pero con un `replyToId` distinto (o mutando de null a reply o viceversa) devolvía el mensaje original silenciosamente en lugar de señalar un conflicto, o aceptaba un replay inconsistente.
- **Remediación**:
  - Se integró `replyToId` a la identidad idempotente: `(conversationId, senderPrincipalId, clientMessageId, body, normalizedReplyToId)`.
  - Normalización formal: se implementó `normalizeReplyToId` en `server/tmComm/tmCommService.ts`. Define explícitamente que `undefined` y `null` se normalizan a `null`. Strings no vacíos se normalizan tras `trim()`. Strings vacíos `""` se preservan como `""` para ser rechazados explícitamente como target inválido y no ser admitidos silenciosamente como null.
  - En `server/tmComm/tmCommHttp.ts`, se implementó `optionalNullableString` para preservar valores `undefined` y `null` válidos, arrojando 400 `FIELD_INVALID` ante tipos no-string.
  - Orden estricto de validación: si existe un registro previo con el mismo `clientMessageId`, se verifica primero la coincidencia de identidad (`sender`, `body`, y `existing.replyToId === normalizedIncomingReplyToId`). Si alguno difiere, se arroja de inmediato HTTP 409 `IDEMPOTENCY_CONFLICT` (`CONFLICT`), antes de evaluar si el nuevo `replyToId` existe o pertenece a otra conversación.
  - Si el replay es verdaderamente idéntico (mismo body y mismo replyToId), devuelve el mensaje existente con HTTP 201/200 de forma idempotente.
  - Si el mensaje es nuevo (`existing === null`), se ejecuta la validación normal de `replyToId`: rechazo 400 `REPLY_TARGET_INVALID` ante target inexistente, target de otra conversación o string vacío.
  - Concurrencia y atomicidad: se envolvió la deduplicación y creación del mensaje dentro de `this.store.withTransaction()` (`BEGIN IMMEDIATE` en SQLite), garantizando serialización atómica ante peticiones concurrentes y previniendo colisiones de unicidad no controladas.
- **Archivos modificados**:
  - `server/tmComm/tmCommHttp.ts`
  - `server/tmComm/tmCommService.ts`
- **Tests agregados/actualizados**:
  - `server/tmComm/tmComm.http.test.ts` (Suite completa `P2-6: replyToId included in idempotency identity with replay vs conflict semantics` cubriendo los 11 escenarios requeridos: 1. replay idéntico con replyToId -> 201; 2. null vs null / omitido replay -> 201; 3. replyToId A vs replyToId B -> 409 IDEMPOTENCY_CONFLICT; 4. antes sin reply y después con reply -> 409 conflict; 5. antes con reply y después sin reply -> 409 conflict; 6. target inexistente en reintento conflictivo -> 409 conflict en vez de éxito silencioso; 7. target de otra conversación en reintento conflictivo -> 409 conflict en vez de éxito silencioso; 8. body modificado -> 409 conflict; 9. inmutabilidad total de los registros originales en SQLite tras conflictos; 10. concurrencia serializada e idempotente bajo `Promise.all`; 11. string vacío `""` rechazado con 400 `REPLY_TARGET_INVALID`).

---

## Remediation Pass 1 (Codex Findings P2-1 to P2-4)

El fresh Codex review ejecutado sobre el exact HEAD `0aef01d195bc4bbe15d564ab6187e65356365d17` identificó 4 findings P2. Los cuatro fueron formalmente remediados en `09e3d946e346cb58a3ef2e176cc8e12e7327e035` conservando todas las invariantes de arquitectura de TM-COMM A0 y sin introducir regresiones ni modificar código histórico de RMZWallet:

### P2-1: Local challenge validation before signing (`PRRC_kwDOQYWUus7xmPd7`)
- **Causa raíz**: La UI de staging (`TmCommStaging.tsx`) tomaba el `canonicalMessage` provisto por el servidor y lo enviaba directamente a `xolosWalletService.signMessage` sin validar localmente los parámetros estructurados del challenge.
- **Remediación**: Se implementó `verifyAndReconstructAuthChallenge(payload, options)` en `src/features/privateMessaging/authChallenge.ts` (re-exportado en el barrel público `src/features/privateMessaging/index.ts`). La función valida exhaustivamente `protocol`, `purpose`, `chain`, `audience`, `origin`, `nonce`, `expiresAt` y `sessionContext`. Reconstruye el mensaje canónico localmente mediante `buildTmCommAuthChallengeMessage` y comprueba igualdad estricta con `payload.canonicalMessage`. En la UI de staging, si la validación falla o detecta manipulación/expiración, se aborta la operación y jamás se invoca `signMessage`.
- **Archivos modificados**:
  - `src/features/privateMessaging/authChallenge.ts`
  - `src/features/privateMessaging/index.ts`
  - `src/routes/TmCommStaging.tsx`
- **Tests agregados/actualizados**:
  - `src/features/privateMessaging/privateMessaging.domain.test.ts` (11 unit tests cubriendo challenge legítimo y rechazo estricto ante manipulación de protocolo, propósito, chain, audience, origin, nonce, expiración, timestamps inválidos, discrepancia con reconstrucción local y payloads no-objeto).
  - `src/routes/TmCommStaging.test.tsx` (8 tests de componente en entorno jsdom verificando que ante un challenge legítimo se invoca `signMessage`, y ante cualquier inconsistencia de protocolo, propósito, audience, origin, nonce, expiración o canonicalMessage se aborta con 0 invocaciones a `signMessage`).

### P2-2: Enforce expected origin on all authenticated mutations (`PRRC_kwDOQYWUus7xmPd_`)
- **Causa raíz**: Las rutas HTTP de mutación autenticada (`POST bindings`, `POST messages`, `PUT receipts`, etc.) no validaban de forma fail-closed el header `Origin` contra la configuración esperada del servidor, y el parser `readJson` permitía bypasses de tipo `text/plain` o sin Content-Type explícito.
- **Remediación**: Se implementó `assertMutationOrigin` en `server/tmComm/tmCommService.ts` e integró en `server/tmComm/tmCommHttp.ts` para todas las rutas mutantes (`POST /v1/tm-comm/bindings`, `POST /v1/tm-comm/conversations/:id/messages`, `PUT /v1/tm-comm/messages/:id/receipts`, mutaciones de adjuntos y cualquier verbo no-GET). Toda petición con `Origin` ausente, foráneo o con puerto discrepante falla de forma inmediata con HTTP 403 `FORBIDDEN` y registra un evento de auditoría en SQLite con `outcome: 'deny'` y `reasonCode: 'ORIGIN_MISMATCH'`. Adicionalmente, `readJson` en `tmCommHttp.ts` valida estrictamente `Content-Type: application/json` y rechaza con HTTP 415 `CONTENT_TYPE_UNSUPPORTED` peticiones `text/plain` o sin header.
- **Archivos modificados**:
  - `server/tmComm/tmCommHttp.ts`
  - `server/tmComm/tmCommService.ts`
- **Tests agregados/actualizados**:
  - `server/tmComm/tmComm.http.test.ts` (Suite de tests P2-2 verificando origin exacto permitido, origin foráneo rechazado con 403, puerto discrepante rechazado con 403, origin ausente rechazado con 403, `text/plain` rechazado con 415, Content-Type ausente rechazado con 415, cookie de sesión válida con origin inválido rechazada con 403, y persistencia de eventos de auditoría 'deny' con `ORIGIN_MISMATCH`).

### P2-3: The sender cannot generate own delivery/read receipts (`PRRC_kwDOQYWUus7xmPeA`)
- **Causa raíz**: El remitente de un mensaje podía emitir sus propios receipts de entrega (`delivered`) y lectura (`read`), inflando artificialmente el estado de agregación del mensaje sin participación del destinatario.
- **Remediación**: En `TmCommService.upsertReceipt` se agregó la validación estricta `receipt.principalId !== message.senderPrincipalId`, rechazando con HTTP 403 `SELF_RECEIPT_FORBIDDEN`. Se validó que el emisor del receipt pertenezca a la conversación excluyendo al remitente (`conversation.participantPrincipalIds - sender`), rechazando con HTTP 403 `RECIPIENT_REQUIRED`. Se prohibió la suplantación de identidad (`claimedPrincipalId !== principal.id`), rechazando con HTTP 403 `RECEIPT_IMPERSONATION`. En `TmCommStore.syncMessageStatus`, se filtran los receipts del remitente para que el estado agregado del mensaje (`accepted`, `delivered`, `read`) se derive estrictamente de receipts emitidos por destinatarios legítimos.
- **Archivos modificados**:
  - `server/tmComm/tmCommService.ts`
  - `server/tmComm/tmCommStore.ts`
- **Tests agregados/actualizados**:
  - `server/tmComm/tmComm.http.test.ts` (Actualización del test de reapertura para validar rechazo 403 al remitente y aceptación del operador; suite dedicada a P2-3 validando rechazo de receipt delivered/read propio con 403 `SELF_RECEIPT_FORBIDDEN`, rechazo a terceros no participantes, rechazo de suplantación con 403 `RECEIPT_IMPERSONATION`, transición de estado a `delivered` y `read` exclusivamente por el destinatario, e idempotencia).

### P2-4: Restore conversation and history after reload (`PRRC_kwDOQYWUus7xmPeF`)
- **Causa raíz**: Al recargar la página, la memoria de React se reinicializaba, perdiendo la conversación y el historial y requiriendo reingresar el token de enrolamiento (que al ser de un solo uso fallaba).
- **Remediación**: En `src/routes/TmCommStaging.tsx` se añadió un hook de hidratación determinista al montar (`useEffect`) que consulta `GET /v1/tm-comm/conversations`. Si existe una sesión activa y autorizada, selecciona la conversación activa de forma determinista (`createdAt` desc, `id` desc) y carga el historial durable desde `GET /v1/tm-comm/conversations/:id/messages`. Si existen múltiples conversaciones autorizadas, renderiza un selector desplegable `<select aria-label="Seleccionar conversación">` para alternar explícitamente entre ellas. Si la recarga no está autenticada (401), el estado permanece limpio sin exponer datos. Se mantiene de forma estricta la invariante arquitectónica: cero uso de `localStorage` como almacenamiento canónico.
- **Archivos modificados**:
  - `src/routes/TmCommStaging.tsx`
- **Tests agregados/actualizados**:
  - `src/routes/TmCommStaging.test.tsx` (3 tests verificando: restauración de conversación e historial durable al recargar con sesión activa sin requerir token de enrolamiento; renderizado del selector de conversaciones y cambio explícito ante múltiples conversaciones; y ausencia de datos/estado limpio ante recarga sin sesión con respuesta 401).

---

## Baseline vs A0 Regression Analysis

Comando idéntico en ambos árboles:

```bash
npm run lint
# eslint .
```

Normalización: únicamente el prefijo de raíz

- BASE: `/tmp/rmzwallet-tm-comm-a0-base/`
- HEAD: `/home/xolosarmy/ecashschool/RMZWallet/`

Finding = `(path relativo, línea, columna, regla ESLint, mensaje)`.

| Métrica | Valor |
| --- | --- |
| **BASE findings** | **328** |
| **HEAD findings** | **328** |
| **NEW findings introduced by A0** | **0** |
| **BASE findings removed incidentally by A0** | **0** |
| Exit BASE | 1 |
| Exit HEAD | 1 |
| Warnings BASE | 0 |
| Warnings HEAD | 0 |
| Findings en archivos TM-COMM | 0 |
| Findings en archivos tocados por A0 | 0 |

Criterio de aprobación del lint diferencial: `NEW findings introduced by A0 = 0`. **Cumple.**

Clasificación de `npm run lint`:

- **FAIL preexistente en BASE** (328 errors / 0 warnings)
- **FAIL preexistente en HEAD** (mismo conjunto; no es PASS)
- **FAIL nuevo en HEAD:** ninguno
- **Fallo ambiental:** ninguno

La suite global de lint ya estaba rota en BASE. No se convirtió artificialmente en PASS. No bloquea A0 porque A0 introduce **cero** regresiones.

Los 328 findings son BASELINE FAILURE / PRE-EXISTING en Tonalli Memo, Agent Wallet Execution, Trusted Wallet Runtime, MemoCompose y aliasDiscovery. **No se modificaron.**

Logs completos: Apéndice A (HEAD) y Apéndice B (BASE).

---

## Archivos modificados (BASE → HEAD)

```text
M  .env.example
A  TM-COMM-A0-architecture-staging-readiness.md
A  docs/tm-comm/*
M  package.json
A  scripts/tm-comm-staging-up.ts
A  server/tmComm/*
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

---

## Modelo de datos

`Principal`, `ReservationBinding`, `Conversation`, `Message`, `MessageReceipt`, `AuditEvent`.

`Message`: `id` servidor, `clientMessageId` idempotente, `conversationId`, `senderPrincipalId`, `senderKind`, `body`, `serverCreatedAt` servidor, `replyToId` opcional, `status` ∈ {accepted, delivered, read}.

Canónico: SQLite. No `localStorage`.

---

## Auth challenge

`TM-COMM-AUTH-V1`. No es `/connect/sign-message`.

Nonce de un solo uso, expiración, audience/origin, session context. Tonalli firma con `signMessage`; keys no salen de la wallet. Servidor verifica address, pubkey, firma, nonce, expiración, origin y context. Cookie HttpOnly `SameSite=Strict`. Address conocida ≠ acceso a reserva. Binding solo con token de enrolamiento de Xolos Ramírez.

---

## Prueba A/B de aislamiento

`server/tmComm/tmComm.http.test.ts`: A no lista/lee/escribe/impersona/adjunta B; ids en URL/body no escapan el ACL. 403 + audit deny.

---

## Persistencia después de reload

Mismo archivo de test: mensaje aceptado sobrevive close/reopen de SQLite + HTTP; historial vía GET con cookie; `clientMessageId` idempotente.

---

## Resultados de tests post-remediación (HEAD actual tras Pass 2)

| Comando | Exit | Clasificación |
| --- | --- | --- |
| `npm run typecheck` | 0 | **PASS** (0 errores) |
| `npm run build` | 0 | **PASS** (compilación limpia para producción) |
| TM-COMM focalizado (`npm run test:tm-comm`) | 0 | **PASS** (5 files / 61 tests) |
| Architecture/boundary (`privateMessaging.architecture.test.ts`) | 0 | **PASS** (8/8) |
| `npm test` suite vigente | 0 | **PASS** (149 files / 2709 vitest + 10 node:test) |
| `npm run test:tm1-regtest-e2e` | 20 | **ENVIRONMENTAL FAILURE** (preexistente en BASE y HEAD; requiere chronik local en :3000) |
| `npm run lint` BASE | 1 | **FAIL preexistente en BASE** (328 errors / 0 warnings) |
| `npm run lint` HEAD | 1 | **FAIL preexistente en HEAD** (328 errors / 0 warnings; NEW=0; 0 en TM-COMM) |

Stderr en tests que pasan (no FAIL): `QuotaExceededError` esperado en RegisterAlias; WASM fallback en x402Activation.

---

## Staging URL

- API: http://127.0.0.1:4178/v1/tm-comm/health → `{"ok":true,"environment":"staging","protocol":"tm-comm","version":1,"financialAuthority":false,"memoPublication":false}`
- UI: http://127.0.0.1:5174/tm-comm-staging → 200

---

## Riesgos residuales

1. **Tokens de staging en `.tmp/`**: Se almacenan tokens de desarrollo y base de datos SQLite en directorio temporal local no versionado.
2. **Ambiente de staging local**: Cookies sin atributo `Secure` en HTTP local `127.0.0.1:4178`; sin rate-limiting de producción.
3. **Ficticio y aislado**: Entorno restringido a staging; operador fixture en bootstrap; email e IA fencados (no implementados).
4. **328 lint findings históricos**: Preexisten en BASE en módulos fuera de TM-COMM (`Tonalli Memo`, `Agent Wallet Execution`, `Trusted Wallet Runtime`, `MemoCompose`, `aliasDiscovery`). Cero findings en archivos TM-COMM.

---

## GO / NO-GO para Fresh Codex Review

**GO: READY FOR FRESH CODEX REVIEW**
- **6/6 Findings P2 remediados formalmente**:
  - P2-1: Validación client-side exhaustiva del challenge antes de invocar `signMessage`.
  - P2-2: Enforce estricto de origin en todas las mutaciones autenticadas con auditoría `ORIGIN_MISMATCH` y rechazo 415 a bypasses sin `application/json`.
  - P2-3: Prohibición de receipts propios del remitente (403 `SELF_RECEIPT_FORBIDDEN`), rechazo a impersonación (403 `RECEIPT_IMPERSONATION`) y derivación estricta de estado a partir de los destinatarios.
  - P2-4: Restauración determinista de conversaciones e historial durable en reload/mount, selector UI multiconversación y estado limpio en 401 sin uso de `localStorage`.
  - P2-5: Fijación estricta de `expectedSessionContext` (`tm-comm-a0-staging:v1`) en cliente contra configuración confiable local, con fail-closed y 0 llamadas a `signMessage` ante cualquier discrepancia.
  - P2-6: Incorporación de `replyToId` normalizado en la identidad idempotente con atomicidad transaccional SQLite (`BEGIN IMMEDIATE`), replay idempotente garantizado y rechazo 409 `IDEMPOTENCY_CONFLICT` inmutable ante variaciones.
- **Validación 100% verde**:
  - `npm run typecheck`: PASS (código 0)
  - `npm run build`: PASS (código 0)
  - `npm run test:tm-comm`: PASS (5 archivos, 61 tests)
  - `npm test`: PASS (149 archivos, 2709 vitest + 10 node:test)
  - `npm run lint`: NEW findings = 0 (328 preexistentes en BASE, 328 en HEAD, 0 en archivos TM-COMM)
- **Invariantes arquitectónicas preservadas**:
  - Cero OpenAI, cero clientes reales, cero fondos reales, cero autoridad financiera, cero Agent Wallet authority, cero settlement, cero broadcast, cero sendXec, cero eToken movement, cero auto-publicación en Tonalli Memo.
  - Sin merge a main, sin avance a M0, sin ampliación de scope.

---

## Apéndice A — `npm run lint` HEAD (FAIL preexistente)

SHA `dbe77d2aea2d893023501b042785e658b9bec91e`. Exit 1. 328 errors / 0 warnings.


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

## Apéndice B — `npm run lint` BASE (FAIL preexistente)

Worktree `/tmp/rmzwallet-tm-comm-a0-base` SHA `ab0024a97ac62f9ba3725b92c553805cb348c7fb`. Exit 1. 328 errors / 0 warnings.

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
