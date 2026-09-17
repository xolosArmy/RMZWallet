# TM-COMM A0 — Architecture & Staging Readiness

Documento de evidencia A0. No es un resumen ejecutivo: registra SHAs, comandos, resultados, fallos, staging, riesgos residuales y la recomendación GO/NO-GO para M0.

**No merge. No producción. No clientes reales. No OpenAI. No fondos reales.**

Fecha de captura: 2026-09-17  
Repositorio: `xolosArmy/RMZWallet`  
Rama: `feat/tm-comm-a0-architecture-staging`  
Ancla obligatoria: `origin/main` resuelto de nuevo al inicio del trabajo, no un SHA histórico supuesto.

---

## 1. Veredicto

**GO para iniciar M0**, con las condiciones de la sección 14.

A0 demuestra que Tonalli Wallet puede hospedar un sistema privado de comunicación futuro sin alterar las fronteras de autoridad financiera existentes.

El único fallo vigente de la suite de verificación **completa** es `npm run lint` del repositorio: **328 errores, 0 warnings**, todos en código preexistente (Tonalli Memo / Agent Wallet / alias). Ninguno está en archivos TM-COMM. Typecheck, build, pruebas focalizadas TM-COMM y la suite vigente de tests pasan.

---

## 2. Identidad git

| Campo | Valor |
| --- | --- |
| SHA base `origin/main` (ancla A0) | `ab0024a97ac62f9ba3725b92c553805cb348c7fb` |
| Mensaje de `origin/main` | `[Gate C3A] RMZWallet Settlement Engine: Durable Ownership, Local TXID Derivation, and Broadcast Boundary (#96)` |
| SHA implementación A0 | `006ac8f0f1bc6d7dedfe95ece54c9ebb94e0171f` |
| Mensaje | `feat(tm-comm): A0 architecture and isolated staging` |
| Autor del commit A0 | `xolosArmy <xolosarmy@xolosarmy>` |
| Fecha del commit A0 | `2026-09-17 08:24:32 -0600` |
| Rama | `feat/tm-comm-a0-architecture-staging` |
| Remoto | `https://github.com/xolosArmy/RMZWallet/tree/feat/tm-comm-a0-architecture-staging` |
| PR / merge | **No se abrió PR. No se hizo merge.** |

Comando de anclaje ejecutado al inicio:

```bash
git fetch origin main
git rev-parse origin/main
# ab0024a97ac62f9ba3725b92c553805cb348c7fb
git checkout -B feat/tm-comm-a0-architecture-staging origin/main
```

El árbol de trabajo de A0 **no** partió de `agent/gate-c3a-wallet-settlement` ni de ningún SHA supuesto.

Este archivo de evidencia se añade después del commit de implementación `006ac8f0…` en la misma rama.

---

## 3. Definition of Done — evidencia

| Criterio A0 | Estado | Evidencia |
| --- | --- | --- |
| Staging separado | CUMPLE | API `:4178`, UI `:5174`, SQLite y secrets en `.tmp/tm-comm-staging/` (gitignored). `environment: staging`. |
| Dos principals autenticados mediante challenge | CUMPLE | `server/tmComm/tmComm.http.test.ts` — wallets A y B firman `TM-COMM-AUTH-V1`. |
| Dos reservation bindings | CUMPLE | Enrolamientos ficticios `rsv_staging_client_a` y `rsv_staging_client_b`. |
| Aislamiento cruzado demostrado | CUMPLE | A no lista/lee/escribe/impersona/adjunta B. Denegaciones auditadas. |
| Al menos un mensaje privado durable | CUMPLE | Mensaje `Durable private message` sobrevive close/reopen del store. |
| Historial recuperado después de reload | CUMPLE | GET de mensajes tras reiniciar SQLite + HTTP server con la misma cookie. |
| API sin autoridad financiera | CUMPLE | Health: `financialAuthority: false`. Arquitectura prohíbe send/settlement/broadcast/keys. |
| Tests de arquitectura de frontera pasando | CUMPLE | 8/8 en `privateMessaging.architecture.test.ts` (tras correcciones; ver §7). |
| Modelo de datos documentado | CUMPLE | Este archivo + `docs/tm-comm/a0-architecture.md`. |
| Diseño de fallback email documentado | CUMPLE | `docs/tm-comm/a0-email-fallback.md` y §11. |
| Threat model corto con riesgos residuales | CUMPLE | `docs/tm-comm/a0-threat-model.md` y §13. |

---

## 4. Comandos ejecutados y resultados finales

Runtime: Node.js `24.19.0` (`engines`: `>=24.18.0 <25`).

### 4.1 Typecheck — PASS (tras un fallo TM-COMM corregido antes del commit)

```bash
npm run typecheck
# tsc -b && tsc -p tsconfig.tm1-regtest-e2e.json
```

**Resultado final:** exit 0.

Fallo intermedio (corregido antes de `006ac8f0`):

```text
server/tmComm/tmCommService.ts(29,3): error TS6133: 'digestEquals' is declared but its value is never read.
```

Se eliminó el import no usado. Typecheck posterior: PASS.

### 4.2 Lint de archivos TM-COMM — PASS

```bash
npx tsc -b && npx eslint src/features/privateMessaging server/tmComm \
  src/routes/TmCommStaging.tsx src/routes/TmCommStaging.test.tsx \
  src/routes/tmCommStagingClient.ts src/config/tmCommStaging.ts \
  src/App.tsx src/routes/More.tsx src/components/walletNavigation.ts \
  scripts/tm-comm-staging-up.ts vite.config.ts
```

**Resultado:** exit 0. Sin output.

### 4.3 Lint del repositorio completo — FAIL (preexistente)

```bash
npm run lint
# eslint .
```

**Resultado vigente sobre HEAD `006ac8f0`:** exit 1.

```text
✖ 328 problems (328 errors, 0 warnings)
  2 errors and 0 warnings potentially fixable with the `--fix` option.
```

Ningún hallazgo en `server/tmComm`, `src/features/privateMessaging`, `src/routes/TmCommStaging*`, `src/config/tmCommStaging.ts` ni `scripts/tm-comm-staging-up.ts`.

La salida completa está en el **Apéndice A**. No se recortó la suite ni se silenciaron reglas.

Corrida anterior, **antes** de quitar `digestEquals`, reportó **329** problemas e incluía este error TM-COMM, ya corregido:

```text
/home/xolosarmy/ecashschool/RMZWallet/server/tmComm/tmCommService.ts
  29:3  error  'digestEquals' is defined but never used  @typescript-eslint/no-unused-vars
```

### 4.4 Build — PASS con warnings

```bash
npm run build
# tsc -b && vite build
```

**Resultado:** exit 0. Vite 7.3.0. `✓ 1419 modules transformed.` `✓ built in 39.33s`. PWA generateSW: 21 entries.

Warnings (no son fallos de exit code; se registran):

```text
node_modules/ox/_esm/core/Base64.js (6:27): A comment "/*#__PURE__*/" ... Rollup cannot interpret
node_modules/@protobufjs/inquire/index.js (12:18): Use of eval ... strongly discouraged
node_modules/minimal-xec-wallet/dist/minimal-xec-wallet.min.js (8586:18): Use of eval
node_modules/minimal-xec-wallet/dist/minimal-xec-wallet.min.js (30020:13): Use of eval

[plugin vite:reporter]
(!) src/services/agoraExchange.ts is dynamically imported by WcWallet.ts but also statically imported by DEXLegacy.tsx
(!) src/services/buyOfferById.ts is dynamically imported by WcWallet.ts but also statically imported by DEXLegacy.tsx, firmaAlphaExchange.ts
(!) src/utils/walletRefresh.ts is dynamically imported by WcWallet.ts but also statically imported by WalletContext.tsx, Nfts.tsx, EcashMultisigService.ts

(!) Some chunks are larger than 500 kB after minification.
dist/assets/interceptor-DNuubyS6.js  3,810.81 kB │ gzip: 2,555.73 kB
dist/assets/index-Ba5bUc2J.js        9,349.78 kB │ gzip: 1,651.35 kB

Browserslist: browsers data (caniuse-lite) is 9 months old.
```

Chunk TM-COMM emitido (lazy): `dist/assets/TmCommStaging-Cgsu6fQz.js` 4.32 kB. La ruta `/tm-comm-staging` **no se monta** salvo `VITE_TM_COMM_STAGING=true` (default `false` en `.env.example`).

### 4.5 Pruebas focalizadas TM-COMM — PASS (22/22)

```bash
npx vitest run src/features/privateMessaging server/tmComm src/routes/TmCommStaging.test.tsx
# equivalente: npm run test:tm-comm
```

**Resultado final:**

```text
 ✓ src/features/privateMessaging/privateMessaging.domain.test.ts (4 tests) 13ms
 ✓ server/tmComm/tmComm.auth.test.ts (3 tests) 15ms
 ✓ server/tmComm/tmComm.http.test.ts (5 tests) 258ms
 ✓ src/features/privateMessaging/privateMessaging.architecture.test.ts (8 tests) 179ms
 ✓ src/routes/TmCommStaging.test.tsx (2 tests) 35ms

 Test Files  5 passed (5)
      Tests  22 passed (22)
 Start at  08:18:14
 Duration  2.93s
```

Casos cubiertos:

- `privateMessaging.architecture.test.ts` (8): archivos de dominio cerrados; sin imports financieros; barrel sin keys/signing/send; send de agente y wallet capability deshabilitados; API server sin `signMsg`/`sendXec`/`agentWalletExecution`/`tonalliMemo`; UI staging sin `sendXEC`/`getMnemonic`/`localStorage.setItem`.
- `privateMessaging.domain.test.ts` (4): entidades A0; challenge `TM-COMM-AUTH-V1` distinto de `/connect/sign-message`; IA/email/Memo fenced.
- `tmComm.auth.test.ts` (3): path `production` rechazado; challenge expirado no crea sesión; config `environment: staging`.
- `tmComm.http.test.ts` (5): health staging; dirección conocida no otorga reserva; nonce de un solo uso + origin mismatch; aislamiento A/B + auditoría deny; durabilidad + idempotencia + receipts.
- `TmCommStaging.test.tsx` (2): ruta ausente con flag off; client usa `credentials: 'include'` y no `localStorage`.

### 4.6 Suite vigente del repositorio — PASS

```bash
npm test
# pretest: node scripts/assert-supported-node-runtime.mjs
# test: vitest run --exclude src/services/slpNftTxBuilder.test.ts && npx tsx --test src/services/slpNftTxBuilder.test.ts
```

```text
Node.js 24.19.0 satisfies >=24.18.0 <25.

 Test Files  149 passed (149)
      Tests  2670 passed (2670)
 Start at  08:21:24
 Duration  33.84s

# segunda fase, node:test slpNftTxBuilder:
ℹ tests 10
ℹ pass 10
ℹ fail 0
ℹ duration_ms 462.704287
```

Total vigente: **2680 tests pass, 0 fail**. La suite no se redujo.

Stderr observado en tests que **aun así pasan** (no omitido):

```text
stderr | src/services/XolosWalletService.x402Activation.test.ts
WebAssembly initialization failed (using fallbacks): Cannot find module './browser-shims/ecash_lib_wasm_browser'
Require stack:
- /home/xolosarmy/ecashschool/RMZWallet/node_modules/minimal-xec-wallet/index.js

stderr | src/routes/RegisterAlias.test.tsx
Failed to set alias in route after successful registration: Error: QuotaExceededError: storage is full
```

El segundo es un caso de prueba que espera el fallo de `setAlias` y confirma que el registro on-chain no se aborta.

---

## 5. Staging

Procesos levantados en esta máquina (independientes de producción):

```bash
npm run tm-comm:staging
# npx tsx scripts/tm-comm-staging-up.ts

VITE_TM_COMM_STAGING=true npx vite --host 127.0.0.1 --port 5174 --strictPort
```

| Superficie | URL | Verificación |
| --- | --- | --- |
| API health | http://127.0.0.1:4178/v1/tm-comm/health | `curl -fsS` → JSON abajo |
| UI staging | http://127.0.0.1:5174/tm-comm-staging | HTTP 200 |
| API vía proxy Vite | http://127.0.0.1:5174/tm-comm-api/v1/tm-comm/health | mismo JSON |

Respuesta health (capturada 2026-09-17):

```json
{"ok":true,"environment":"staging","protocol":"tm-comm","version":1,"financialAuthority":false,"memoPublication":false}
```

Vite:

```text
VITE v7.3.0  ready in 191 ms
➜  Local:   http://127.0.0.1:5174/
```

Datos de staging (gitignored, `.tmp/`):

| Path | Modo | Rol |
| --- | --- | --- |
| `.tmp/tm-comm-staging/tm-comm-a0.sqlite` | WAL | registro canónico |
| `.tmp/tm-comm-staging/tm-comm-a0.sqlite-wal` | | journal |
| `.tmp/tm-comm-staging/tm-comm-a0.sqlite-shm` | | shared memory |
| `.tmp/tm-comm-staging/bootstrap-receipt.json` | 0600 | tokens de enrolamiento ficticios |
| `.tmp/tm-comm-staging/operator-wallet.json` | 0600 | address/pubkey de operador ficticio (sin clave de producción) |

Bootstrap capturado (sin tokens en claro en este informe):

- `environment`: staging
- `databasePath`: `/home/xolosarmy/ecashschool/RMZWallet/.tmp/tm-comm-staging/tm-comm-a0.sqlite`
- `expectedOrigin`: `http://127.0.0.1:5174`
- `operatorPrincipalId`: `prin_87e3b3c587622989eedf045eb07f6034`
- `operatorAddress`: `ecash:qrllvn2cqmt7whkax5fadayg2pw5xxmhhqtua8prfr`
- Client A: reserva `rsv_staging_client_a`, email placeholder `client-a.staging@invalid.test`, token length 48
- Client B: reserva `rsv_staging_client_b`, email placeholder `client-b.staging@invalid.test`, token length 48

Los tokens viven solo en el receipt local. No se copian aquí.

Reproducción desde cero: `docs/tm-comm/a0-staging.md`.

Guardas:

- `TM_COMM_ENVIRONMENT=production` se rechaza
- paths de DB con `production` / `prod-data` / `mainnet-secrets` se rechazan
- `VITE_TM_COMM_STAGING=false` por defecto
- Agent Wallet, settlement, broadcast y Memo no arrancan con este proceso

---

## 6. Modelo de dominio cerrado

Entidades autoritativas:

| Entidad | Rol |
| --- | --- |
| `Principal` | Identidad emitida por el servidor tras challenge verificado. Una dirección conocida no es autorización. |
| `ReservationBinding` | Vínculo explícito principal ↔ reserva ficticia. Solo con token de enrolamiento de Xolos Ramírez. |
| `Conversation` | Un hilo por reserva. Participantes: cliente bindeado + operador. |
| `Message` | Mensaje privado durable. Id y timestamp de servidor. |
| `MessageReceipt` | Estado `delivered` / `read` por principal, compatible con receipts posteriores. |
| `AuditEvent` | allow/deny sin cuerpos ni secretos. |

Campos mínimos de `Message`: `id`, `clientMessageId` (idempotente por conversación), `conversationId`, `senderPrincipalId`, `senderKind`, `body`, `serverCreatedAt`, `replyToId` opcional, `status` ∈ {`accepted`,`delivered`,`read`}.

Persistencia canónica: SQLite `node:sqlite`, WAL + `synchronous=FULL` en archivos. `localStorage` no es fuente de verdad.

### Autenticación wallet

Protocolo dedicado `TM-COMM-AUTH-V1`. **No** es `/connect/sign-message` ni el Mining Gateway.

1. El servidor emite nonce de un solo uso, expiración, audience/origin esperado y `sessionContext`.
2. Tonalli firma el string canónico con `xolosWalletService.signMessage`.
3. Las claves privadas no salen de Tonalli.
4. El servidor verifica dirección, pubkey comprimida ligada a la address, firma (`verifyMsg`), nonce no consumido, expiración, origin/audience y session context.
5. Cookie de sesión HttpOnly, `SameSite=Strict`, `Path=/`. La sesión **no** concede acceso a reservas.

### Binding

Una address autenticada tiene bindings vacíos hasta consumir la invitación. Si el body envía un `reservationId` distinto al del token → `RESERVATION_CLAIM_MISMATCH` (403) y audit deny. El diseño contempla entrega posterior al correo previamente verificado del cliente (A0 no envía correo).

### API mínima

Autorización solo desde el principal de sesión. Campos de navegador `customerId`, `reservationId`, `conversationId`, `walletAddress`, `senderPrincipalId` son claims.

| Método | Path |
| --- | --- |
| GET | `/v1/tm-comm/health` |
| POST | `/v1/tm-comm/challenges` |
| POST | `/v1/tm-comm/sessions` |
| GET | `/v1/tm-comm/me` |
| POST | `/v1/tm-comm/bindings` |
| GET | `/v1/tm-comm/conversations` |
| GET | `/v1/tm-comm/conversations/:id` |
| GET | `/v1/tm-comm/conversations/:id/messages` |
| POST | `/v1/tm-comm/conversations/:id/messages` |
| GET | `/v1/tm-comm/messages/:id/receipts` |
| PUT | `/v1/tm-comm/messages/:id/receipts` |
| GET | `/v1/tm-comm/attachments/:id` (fail closed en A0) |

### Aislamiento A/B demostrado

El test `client A cannot read, list, send as, or touch metadata of client B` comprueba que A no puede:

- listar la conversación de B (`GET /conversations/:id` → 403)
- leer mensajes de B
- enviar como B (`senderPrincipalId` / `customerId` / `walletAddress` / `reservationId` ajenos → 403)
- escribir en la conversación de B
- obtener adjuntos (`GET /attachments/:id` → 403 `ATTACHMENT_UNAVAILABLE`)
- marcar receipt de un mensaje de B
- escapar el ACL modificando identificadores en URL/body

Reasons de audit deny observadas: `CONVERSATION_FORBIDDEN`, `SENDER_IMPERSONATION`, `ATTACHMENT_UNAVAILABLE`, `RESERVATION_CLAIM_MISMATCH`.

---

## 7. Fallos intermedios de TM-COMM (no ocultos; corregidos antes del commit)

Primera corrida focalizada: **8 failed / 14 passed**.

1. `CHECK constraint failed: application_id = 1413956401` — el literal SQL no coincidía con `0x544d4331` (1414349617). Corregido interpolando la constante. Además, Vitest aliasa `node:crypto` a un shim sin `randomBytes`; IDs y wallets de test pasan a `crypto.getRandomValues`.
2. `TM_COMM_LISTEN_PORT is invalid` — se rechazaba puerto `0` (efímero en tests). Ahora `listenPort >= 0`.
3. Arquitectura: `tmCommTestUtils.ts` importaba `signMsg`. El filtro `testUtils` era case-sensitive (`TestUtils`). Filtro insensible a mayúsculas.
4. `TmCommStaging.test.tsx`: `useWallet debe usarse dentro de WalletProvider` al renderizar `App`. Se mockeó `useWallet`/`TopBar` como el test de x402.
5. Typecheck/lint: `digestEquals` no usado. Import eliminado.

Segunda corrida focalizada (aún rota por el CHECK y `randomBytes is not a function` en durabilidad). Tercera corrida: **22/22 pass**. Esos fallos no están en HEAD.

---

## 8. Frontera financiera

Tests de arquitectura fallan si `privateMessaging`, rutas API `server/tmComm` (producción) o el registro de IA importan o referencian:

- signing (`signMsg` / `signMessage` en el dominio cerrado)
- `privateKey` / `secretKey` / `mnemonic` / `WIF`
- settlement / broadcast (`broadcastTx`, `broadcastTransaction`)
- `sendXec` / `sendETokens`
- publicación automática Tonalli Memo
- capacidades privadas de `agentWalletExecution` (`createAgentWalletExecutionEngine`)

La UI de staging **sí** puede llamar `xolosWalletService.signMessage` para el challenge. Eso es firma de mensaje de wallet, no una capacidad financiera de TM-COMM. El dominio cerrado no importa `XolosWalletService` ni `ecash-lib`.

Agent Wallet **no se modificó**.

---

## 9. Fallback email (contrato A0; implementación M1)

`TM_COMM_EMAIL_FALLBACK_IMPLEMENTED = false`.

Disparadores: `no-live-session`, `unread-after-ttl`, `operator-initiated-notice`.

El mensaje canónico ya existe en SQLite antes de considerar email.

Permitido: aviso de que existe un mensaje privado; referencia opaca de conversación; link Tonalli; recordatorio de enrolamiento al correo previamente verificado.

Prohibido: cuerpo completo; datos de otro cliente; session token; material privado de wallet; token de enrolamiento vivo tras consumo.

Dedup: tabla `tm_comm_email_dispatches`, unique `(message_id, principal_id, channel)` con `channel = 'email-fallback'`. Estados: `pending` / `sent` / `failed` / `suppressed`. Un segundo disparo reutiliza la fila.

---

## 10. IA futura (sin OpenAI)

No hay integración OpenAI.

| Clase | Tools | A0 |
| --- | --- | --- |
| Read | `listAuthorizedConversations`, `listAuthorizedMessages` | enabled, ACL del principal |
| Communication | `draftMessage` | enabled, no envía |
| Communication | `sendMessage` | **disabled** |
| Privileged | commercial / logistics / financial / on-chain / memoPublication / walletCapability | **disabled** |

Regla dura: un principal `agent` autenticado **nunca** recibe capacidad de Wallet por ese hecho.

`isTmCommAgentSendEnabled() === false`  
`agentAuthenticationGrantsWalletCapability() === false`

---

## 11. Tonalli Memo (M3; fuera de A0/M0/M1/M2 salvo contrato)

`TM_COMM_AUTOMATIC_MEMO_PUBLICATION = false`.

Una conversación privada nunca se publica automáticamente.

Pipeline futuro:

```text
private event
→ candidate evidence
→ public preview
→ human approval
→ Wallet authorization / signature when applicable
→ Tonalli Memo
```

No hay atajo a OP_RETURN, broadcast ni ingesta del feed Memo.

---

## 12. Archivos añadidos y modificados

Commit `006ac8f0`: 40 files, +4213 / −2.

Añadidos:

```text
docs/tm-comm/README.md
docs/tm-comm/a0-ai-agent-boundary.md
docs/tm-comm/a0-architecture.md
docs/tm-comm/a0-email-fallback.md
docs/tm-comm/a0-staging.md
docs/tm-comm/a0-threat-model.md
docs/tm-comm/a0-tonalli-memo-boundary.md
scripts/tm-comm-staging-up.ts
server/tmComm/index.ts
server/tmComm/tmComm.auth.test.ts
server/tmComm/tmComm.http.test.ts
server/tmComm/tmCommBootstrap.ts
server/tmComm/tmCommConfig.ts
server/tmComm/tmCommHttp.ts
server/tmComm/tmCommIds.ts
server/tmComm/tmCommSchema.ts
server/tmComm/tmCommService.ts
server/tmComm/tmCommStore.ts
server/tmComm/tmCommTestUtils.ts
server/tmComm/tmCommVerify.ts
src/config/tmCommStaging.ts
src/features/privateMessaging/aiAgentBoundary.ts
src/features/privateMessaging/authChallenge.ts
src/features/privateMessaging/contracts.ts
src/features/privateMessaging/emailFallbackContract.ts
src/features/privateMessaging/errors.ts
src/features/privateMessaging/index.ts
src/features/privateMessaging/memoPublicationBoundary.ts
src/features/privateMessaging/privateMessaging.architecture.test.ts
src/features/privateMessaging/privateMessaging.domain.test.ts
src/features/privateMessaging/types.ts
src/routes/TmCommStaging.test.tsx
src/routes/TmCommStaging.tsx
src/routes/tmCommStagingClient.ts
```

Modificados:

```text
.env.example
package.json
src/App.tsx
src/components/walletNavigation.ts
src/routes/More.tsx
vite.config.ts
```

Este archivo `TM-COMM-A0-architecture-staging-readiness.md` se añade en un commit posterior de evidencia, misma rama, sin merge.

---

## 13. Modelo de amenazas y riesgos residuales

Alcance: mensajería privada de staging hospedada por Tonalli. Sin datos de producción.

Activos: cuerpos de mensaje; bindings; cookies de sesión; tokens de enrolamiento; claves privadas de wallet (deben permanecer en Tonalli).

Actores: cliente ficticio A; cliente ficticio B; operador staging (Xolos Ramírez); atacante de navegador que edita URL/JSON; agente de IA futuro.

Controles A0:

| Riesgo | Control |
| --- | --- |
| Lectura/escritura cruzada | ACL de servidor desde principal de sesión + participantes. Ids de cliente son claims. |
| Address como autoridad | Auth ≠ binding. Token de enrolamiento obligatorio. |
| Reuso de challenge | Nonce de un solo uso, hash en reposo, consumo atómico. |
| Mint de sesión cross-origin | Audience/origin y session context en servidor. |
| Exfiltración de claves | Firma vía `signMessage` de Tonalli. TM-COMM no ve keys. |
| Confusión financiera | Tests de arquitectura. |
| Fuga de adjuntos | Rutas fail closed. |
| Fuga en logs | Audit con reason codes, no cuerpos ni tokens. |
| Duplicación de email (futuro) | Unique dispatch key; implementación M1. |
| Exceso del agente | Send off; privileged off; no wallet capability por auth de agente. |
| Producción accidental | Config staging-only; paths/env de producción rechazados; flag UI default false. |

Riesgos residuales (abiertos):

1. Los tokens de enrolamiento en `.tmp/` son secretos de esa máquina; quien tenga el archivo puede bindear una wallet de staging a una reserva ficticia.
2. Cookies HttpOnly en HTTP localhost omiten `Secure`. HTTPS futuro debe activarlo.
3. El challenge es plaintext visible al usuario. No debe incluir contenido de reserva.
4. A0 no tiene rate limit; el staging local es brute-forceable.
5. La verificación depende de `ecash-lib` `verifyMsg`. Un frontend comprometido no mina sesión sin firma válida, pero XSS en el origen de staging podría usar Tonalli ya desbloqueada para firmar un challenge fresco. El origen de staging se trata como trusted.
6. El operador es un fixture de staging, no identidad hardware.
7. Email e IA no están implementados. El riesgo residual es que un milestone posterior habilite send/email sin repetir aislamiento.

---

## 14. Limitaciones conocidas (intencionales) y GO / NO-GO

Limitaciones:

- No hay experiencia completa de chat.
- Email fallback: contrato solamente.
- OpenAI no integrado.
- Memo fuera de A0/M0/M1/M2 salvo frontera.
- Sin rate-limit.
- Cookie sin `Secure` en HTTP local.
- El chunk lazy `TmCommStaging-*.js` se emite en el build de producción, pero la ruta no se monta si el flag está en false.

### Recomendación: **GO para M0**

Condiciones:

1. Permanecer en `feat/tm-comm-a0-architecture-staging`. **No merge a `main`.**
2. Seguir con datos ficticios y SQLite de staging. Cero expedientes, wallets o fondos reales.
3. No habilitar `sendMessage` de agente, email real ni OpenAI en M0.
4. Tratar los **328 errores de ESLint preexistentes** como deuda aparte. No son bloqueo de TM-COMM. No se silenciaron para este A0.
5. M0 construye UX mínima sobre este ACL y este store. No sobre `localStorage`, no sobre `/connect/sign-message`, no sobre Agent Wallet.

**NO-GO** si se pretendiera merge, producción, clientes reales, OpenAI, o publicación Memo desde A0. Nada de eso está autorizado.

---

## Apéndice A — salida completa de `npm run lint` (HEAD `006ac8f0`)

Exit code 1. 328 errors. Capturada 2026-09-17. TM-COMM no aparece.


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
