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
| **PASS 3 REVIEWED HEAD** | `f47f5fedb4195803d66622ddce76a137de72f12a` |
| **PASS 3 REMEDIATION SHA** | `44e26fb2996d933ca94d13e3135a511fe1e36067` |
| **PASS 4 REVIEWED HEAD** | `9d407a81f00605e73b9b8b76fb3ec4f350e7f117` |
| **PASS 4 REMEDIATION SHA** | `037b420067ffec3bf577884d5f2ca0ec79ea54a5` |
| **PASS 8 REVIEWED HEAD** | `97a45686a7c533f6c9867bc6ebd155140c61a3a2` |
| **PASS 8 REMEDIATION SHA** | `6c06d481d1b43666a5ce8ee9578b580fdbb6f79c` |
| **PASS 9 REVIEWED HEAD** | `6c06d481d1b43666a5ce8ee9578b580fdbb6f79c` |
| **PASS 9 REMEDIATION SHA** | Exact HEAD of `feat/tm-comm-a0-architecture-staging` (PR #98 Pass 9 closure) |
| Staging API | http://127.0.0.1:4178/v1/tm-comm/health |
| Staging UI | http://127.0.0.1:5174/tm-comm-staging |
| Estado | **READY FOR FRESH CODEX REVIEW (PASS 9 CLOSURE)** |
| Merge | **No** |

---

## Remediation Pass 9 (Codex Findings P2-17 & P2-18)

El fresh Codex review ejecutado sobre el exact HEAD `6c06d481d1b43666a5ce8ee9578b580fdbb6f79c` identificó exactamente 2 findings P2 abiertos:
1. `Reset busy state when invalidating an operation` (Thread `PRRT_kwDOQYWUus6kFE6n`)
2. `Hide private history before a wallet-change render commits` (Thread `PRRT_kwDOQYWUus6kFE6p`)

Ambos findings han sido completamente remediados conservando todas las remediaciones e invariantes de arquitectura anteriores:

### P2-17: Hide private history before a wallet-change render commits (Thread `PRRT_kwDOQYWUus6kFE6p`)
- **Causa raíz**: En React, `useEffect` se ejecuta asíncronamente después del layout y commit del DOM. Al alternar la wallet activa de `addressA` a `addressB` en el contexto global, React ejecutaba un ciclo de renderizado bajo `addressB` *antes* de que el effect pudiera ejecutarse y limpiar `conversations`, `conversation`, `messages` y el log de evidencia. Como resultado, durante ese render intermedio, el árbol JSX continuaba exponiendo conversaciones, mensajes e identificadores pertenecientes a la identidad anterior bajo el nuevo encabezado de cuenta.
- **Remediación**:
  1. **Render Gate Canónico Pre-Commit**: Se definió la condición canónica estricta durante el render:
     `const sessionCoherent = initialized && Boolean(address) && authenticatedWalletAddress === address`
     Cualquier render donde `sessionCoherent === false` tiene la garantía absoluta de no exponer en el árbol Virtual DOM ningún elemento derivado de la sesión anterior, independientemente de los tiempos de ejecución de los effects.
  2. **Valores Derivados Seguros**: En lugar de renderizar directamente las variables de estado reactivo, se derivan valores limpios en la fase de render:
     - `visibleConversations = sessionCoherent ? conversations : []`
     - `visibleConversation = sessionCoherent ? conversation : null`
     - `visibleMessages = sessionCoherent ? messages : []`
     - `visibleEnrollmentToken = sessionCoherent ? enrollmentToken : ''`
     - `visibleMessageBody = sessionCoherent ? messageBody : ''`
  3. **Particionamiento y Privacidad de Log**: El log local de evidencia se modeló con tipado explícito `LogEntry = { address: string | null; isPrivate: boolean; text: string }`.
     `visibleLog = log.filter((entry) => entry.address === address && (sessionCoherent || !entry.isPrivate)).map((entry) => entry.text)`
     Cualquier entrada que contenga metadatos de sesión (IDs de conversación, reservas, mensajes o conteos de sincronización) se registra con `isPrivate: true` y se oculta de inmediato si `sessionCoherent` es falso o si pertenece a una wallet distinta. Las trazas operativas (fallos de autenticación, rechazos de red) permanecen visibles para la wallet activa.
  4. **Purga y Aislamiento de Formularios**: Los campos `enrollmentToken` y `messageBody` se ocultan inmediatamente en render (`visible*`) y se purgan sincrónicamente en `useEffect` al cambiar de wallet, impidiendo que borradores o invitaciones de una cuenta queden disponibles para otra.

### P2-18: Reset busy state when invalidating an operation (Thread `PRRT_kwDOQYWUus6kFE6n`)
- **Causa raíz**: Cuando una operación de red (`authenticate`, `bind`, `send`) quedaba en vuelo bajo la wallet A (`busy = true`), cambiar de cuenta a B abortaba los controladores de aborto e incrementaba las generaciones de sesión, pero el flag `busy` permanecía activo hasta que la promesa en vuelo resolviera o rechazara. Esto dejaba la interfaz de la nueva wallet bloqueada con botones deshabilitados de forma innecesaria.
- **Remediación**:
  1. **Invalidación Síncrona de Busy**: En el `useEffect` que monitorea `[address, initialized]` y en su función de limpieza (cleanup), se invoca explícitamente `setOperationBusy(false)` en el mismo paso donde se invalidan las generaciones y se abortan las peticiones.
  2. **Busy Rastreado por Dirección**: Se introdujo `busyAddress` para vincular cualquier operación en curso a la wallet que la originó: `const isBusy = busy && busyAddress === address`. Al cambiar de wallet, la nueva identidad no hereda el estado ocupado de la anterior.
  3. **Preservación de Generation Guards**: Los bloques `finally` en `authenticate`, `bind` y `send` mantienen sus comprobaciones de generación (`if (activeGen === currentGen)`), impidiendo que operaciones retrasadas de generaciones antiguas alteren el estado de ocupado de la nueva sesión.

- **Archivos modificados**:
  - `src/routes/TmCommStaging.tsx`
  - `src/routes/TmCommStaging.test.tsx`
- **Tests agregados**:
  - `src/routes/TmCommStaging.test.tsx`: 9 nuevos tests unitarios e integrados bajo `describe('P2-17 & P2-18: Pre-commit privacy gate and busy state invalidation')` verificando:
    1. Render gate inmediato al alternar A → B (mensajes, IDs, reservas, selector y logs de A ausentes del DOM en el primer render).
    2. Auth pendiente en A + cambio a B (botón de autenticación en B inmediatamente habilitado; resolución tardía de A no bloquea a B).
    3. Bind pendiente en A + cambio a B (UI de B no bloqueada; resolución de A no afecta a B).
    4. Send pendiente en A + cambio a B (UI de B no bloqueada; resolución de A no afecta a B).
    5. Finalización tardía de A no altera busy ni repuebla contenido bajo B.
    6. Cambios rápidos A → B → C retienen únicamente estado compatible con C.
    7. Montaje inicial con cookie de A y wallet activa B falla cerrado sin datos privados en DOM.
    8. Recarga con wallet A y cookie de A restaura sesión válida.
    9. Formularios (token y mensaje) de A se purgan y no se filtran a B.
  - Total suite de TM-COMM: 6 suites, 127/127 tests passing.

---

## Remediation Pass 8 (Codex Findings P2-15 & P2-16)

El fresh Codex review ejecutado sobre el exact HEAD `97a45686a7c533f6c9867bc6ebd155140c61a3a2` identificó exactamente 2 findings P2 abiertos:
1. `Reset TM-COMM state when the active wallet changes` (Thread `PRRT_kwDOQYWUus6kDt62`)
2. `Reject databases with mismatched metadata` (Thread `PRRT_kwDOQYWUus6kDt64`)

Ambos findings han sido completamente remediados conservando todas las remediaciones e invariantes de arquitectura anteriores:

### P2-15: Reset TM-COMM state when the active wallet changes (Thread `PRRT_kwDOQYWUus6kDt62`)
- **Causa raíz**: Cuando el usuario alternaba de cuenta en la wallet activa mientras la ruta `TmCommStaging` permanecía montada, o cuando la wallet se bloqueaba/desinicializaba, el valor de `address` cambiaba pero el estado local (`conversations`, `conversation`, `messages`, cookie HttpOnly de sesión y generaciones) continuaba asociado a la identidad previa. La página mostraba visualmente la wallet B pero retenía el historial privado de A, y cualquier acción de enrolamiento (`bind`) o envío de mensajes consumía la sesión de A, arriesgando vincular tokens de B a favor de A. Asimismo, al montar o recargar la ruta con una sesión de A persistente en cookie pero con la wallet activa fijada en B, el cliente intentaba hidratar el historial de A bajo la identidad de B.
- **Remediación**:
  1. **Identidad autenticada explícita**: Se introdujo el concepto de `authenticatedWalletAddress` y `authenticatedWalletAddressRef` en `src/routes/TmCommStaging.tsx`, estrictamente diferenciado de la wallet actualmente seleccionada en el contexto global. Solo se establece tras un handshake exitoso de autenticación TM-COMM o tras verificar que la sesión persistente en cookie pertenece a la wallet activa.
  2. **Verificación de identidad en hidratación / reload**: `restoreAuthorizedConversations` realiza una consulta previa a `GET /v1/tm-comm/me` para cotejar criptográficamente el `walletAddress` de la sesión devuelta contra la wallet activa (`targetAddress`). Si la sesión pertenece a otra wallet o retorna 401, se purga todo el estado y se falla cerrado (`authenticatedWalletAddress = null`).
  3. **Reacción reactiva a cambios de wallet o bloqueo**: El `useEffect` suscrito a `[address, initialized]` aborta inmediatamente las operaciones en curso (`hydrationAbortRef.current?.abort()`, `messageAbortRef.current?.abort()`), incrementa `sessionGenerationRef` y `messageRequestGenRef` para invalidar respuestas asíncronas tardías, y limpia sincrónicamente todo el estado sensible (`conversations`, `conversation`, `messages`, `activeConversationIdRef = null`, `authenticatedWalletAddress = null`). Si la wallet se bloquea o desinicializa, el estado se contiene y purga de inmediato.
  4. **Guards de mutación y controles UI**: Las funciones `bind()`, `send()` y `refreshMessages()` aplican verificaciones defensivas síncronas (`authenticatedWalletAddressRef.current === address`). Si no hay coherencia exacta entre la sesión autenticada y la wallet activa, la mutación es abortada de forma fail-closed. En la UI, los inputs, botones de acción y selector de conversaciones permanecen deshabilitados si no se cuenta con una sesión autenticada para la wallet activa, mostrando un indicador claro del estado de la sesión TM-COMM.
- **Archivos modificados**:
  - `src/routes/TmCommStaging.tsx`
- **Tests agregados/actualizados**:
  - `src/routes/TmCommStaging.test.tsx` (8 nuevos tests deterministas en `describe('P2-13: Wallet-session coherence and state containment')` cubriendo: mount con cookie de A y wallet activa B falla cerrado; reload con cookie y wallet coincidentes restaura sesión; alternar de wallet A a B purga inmediatamente historial y conversaciones de A; peticiones pendientes de A no mutan a B; bind y send bloqueados tras switch hasta reautenticar B; reautenticación de B solo hidrata estado de B; desinicialización/bloqueo de wallet purga estado privado de inmediato; y respuestas tardías o 401s obsoletos de sesión anterior no mutan la sesión actual. 37/37 tests passing).

### P2-16: Reject databases with mismatched metadata (Thread `PRRT_kwDOQYWUus6kDt64`)
- **Causa raíz**: Cuando el proceso abría una base de datos creada por otra versión o proceso, `TmCommStore` ejecutaba `CREATE TABLE IF NOT EXISTS` sin validar `schema_version`, `environment` ni `application_id` contra las constantes del sistema. Dado que SQLite no migra tablas existentes bajo `IF NOT EXISTS`, el arranque procedía y `bootstrapTmCommStaging` escribía principals y tokens asumiendo la semántica canónica de v1, arriesgando corrupción silenciosa de esquemas ajenos o de versiones futuras/incompatibles.
- **Remediación**:
  1. **Error específico de compatibilidad**: Se implementó `TmCommMetadataMismatchError` con código canónico `'TM_COMM_METADATA_MISMATCH'`.
  2. **Detección y orden de inicialización fail-closed**: En `initializeSchemaAndMetadata`, se consulta `sqlite_master`:
     - **Base de datos nueva (cero tablas de usuario)**: Crea el esquema canónico completo vía `TM_COMM_SQLITE_SCHEMA_SQL`, inserta la fila canónica en `tm_comm_metadata` (`singleton_id = 1`, `schema_version = 1`, `application_id = 0x544d4331`, `environment = 'staging'`) y valida la inserción.
     - **Base de datos existente (con tablas)**: Comprueba si existe la tabla `tm_comm_metadata`. Si está ausente (base de datos ajena o no inicializada por TM-COMM), falla cerrado inmediatamente lanzando `TmCommMetadataMismatchError` sin crear esquemas ni adoptar tablas ajenas. Si existe, valida que la fila única (`singleton_id = 1`) contenga tipos válidos y valores exactos: `schema_version === TM_COMM_SQLITE_SCHEMA_VERSION (1)`, `application_id === TM_COMM_SQLITE_APPLICATION_ID (0x544d4331)` y `environment === 'staging'`. Ante cualquier discrepancia, lanza `TmCommMetadataMismatchError`.
  3. **Cierre limpio del handle SQLite**: El constructor de `TmCommStore` encapsula toda la inicialización en `try ... catch` y ejecuta `this.close()` ante cualquier excepción antes de propagarla, liberando de inmediato file descriptors y bloqueos activos.
  4. **Exportación de constantes de compatibilidad**: `TM_COMM_SQLITE_APPLICATION_ID` y `TM_COMM_SQLITE_SCHEMA_VERSION` se exportan públicamente desde `server/tmComm`.
- **Archivos modificados**:
  - `server/tmComm/tmCommStore.ts`
  - `server/tmComm/index.ts`
- **Tests agregados/actualizados**:
  - `server/tmComm/tmCommRestart.test.ts` (11 nuevos tests deterministas en `describe('P2-15: SQLite metadata compatibility gate')` cubriendo: inicialización correcta de DB nueva con metadata canónica; validación limpia de DB existente compatible; rechazo con fail-closed ante `schema_version` superior (2); rechazo ante `schema_version` inferior (0 o negativo); rechazo ante `application_id` discrepante; rechazo ante `environment` discrepante; rechazo de DB ajena no vacía sin `tm_comm_metadata`; rechazo de fila de metadata incompleta o con tipos corruptos; garantía de que ninguna discrepancia crea tablas de aplicación; fallo de `bootstrapTmCommStaging` antes de escribir principals o tokens sobre DB incompatible; y cierre limpio del handle sin bloqueos residuales tras error de inicialización. 39/39 tests passing).

---

## Remediation Pass 4 (Codex Findings P2-8, P2-9, P2-10)

El fresh Codex review ejecutado sobre el exact HEAD `9d407a81f00605e73b9b8b76fb3ec4f350e7f117` identificó exactamente 3 findings P2. Han sido formalmente remediados conservando todas las remediaciones anteriores (P2-1 a P2-7) y las invariantes de arquitectura de TM-COMM A0:

### P2-8: Atomic and exclusive operator credential creation (`PRRC_kwDOQYWUus7xoXfq` / Thread `PRRT_kwDOQYWUus6kBUcV`)
- **Causa raíz**:
  El patrón anterior `existsSync` seguido de `writeFileSync` en `server/tmComm/tmCommTestUtils.ts` presentaba una condición de carrera TOCTOU. Si dos procesos de staging arrancaban simultáneamente contra un directorio limpio, ambos podían observar la ausencia de credencial y de operador en SQLite; al no usar creación exclusiva, uno de los procesos podía sobrescribir/truncar el archivo persistiendo la billetera B mientras el otro proceso ya había inicializado la base de datos con la billetera A. Dado que el puerto se enlaza posteriormente, un fallo por `EADDRINUSE` no prevenía el descalce, provocando que todos los reinicios subsiguientes fallaran cerrado (`OPERATOR_IDENTITY_MISMATCH`).
- **Remediación**:
  - **Creación Atómica Exclusiva**: Se configuró `writeFileSync` con el flag `wx` (`O_CREAT | O_EXCL`) y modo estricto `0o600` (con directorio `0o700`). Exactamente un proceso del sistema operativo gana la creación del inodo en el kernel.
  - **Manejo Determinista de EEXIST con Reintento Bounded**: El proceso que recibe `EEXIST` (perdedor) jamás regenera ni trunca el archivo. En su lugar, invoca `loadAndValidateWinningCredential`, la cual implementa reintentos con backoff síncrono (`sleepSync` basado en `Atomics.wait` sobre `SharedArrayBuffer`) tolerando la ventana transitoria en la que el ganador finaliza la escritura.
  - **Fail-Closed Ante Archivos Incompletos / Corruptos**: Si el archivo continúa incompleto o corrupto tras agotar los reintentos, el sistema falla cerrado sin sustitución silenciosa ni regeneración.
  - **Invariante de No-Truncamiento**: Los archivos existentes válidos se abren de forma segura y nunca son truncados ni reemplazados.
- **Tests agregados en `server/tmComm/tmCommRestart.test.ts`**:
  - Concurrencia real a nivel de proceso (`spawn` de dos procesos simultáneos vía `npx tsx` sobre directorio nuevo/limpio): ambos convergen deterministamente en la misma identidad ganadora, exactamente 1 archivo persistido, exactamente 1 Principal operador en SQLite, y 0 Principals cliente.
  - Perdedor ante `EEXIST` recarga la credencial ganadora sin generar una nueva.
  - Lectura durante escritura parcial se reintenta hasta disponer de JSON válido.
  - Archivo parcial/corrupto permanente falla cerrado tras agotar intentos.
  - Archivo existente jamás es truncado ni alterado.

### P2-9: Correct Staging Documentation for Private Key Material (`PRRC_kwDOQYWUus7xoXfx` / Thread `PRRT_kwDOQYWUus6kBUca`)
- **Causa raíz**:
  La tabla de artefactos en `docs/tm-comm/a0-staging.md` describía `operator-wallet.json` indicando únicamente campos públicos, omitiendo que la remediación escribe `secretHex` (material de clave privada). Esto podía inducir a tratar o compartir el archivo como metadatos públicos en tickets o logs.
- **Remediación**:
  - Se actualizó la fila de la tabla en `docs/tm-comm/a0-staging.md` señalando explícitamente: `operator-wallet.json | Clave privada fixture del operador (secretHex, address, publicKeyHex) generada deterministamente para staging. PRIVATE KEY MATERIAL / STAGING SECRET.`
  - Se añadió una sección de advertencia de seguridad detallando los requisitos de manejo: permisos `0600` para el archivo, `0700` para el directorio contenedor, exclusión estricta en `.gitignore`, prohibición de compartir en capturas/tickets/logs, destrucción junto con los artefactos de staging, y la invariante arquitectónica verbatim:
    `"Staging operator credential persistence is test-fixture infrastructure only and MUST NOT become the production operator key-management model."`

### P2-10: Session-Generation-Safe Hydration and State Containment (`PRRC_kwDOQYWUus7xouJS` / Thread `PRRT_kwDOQYWUus6kBjkS`)
- **Causa raíz**:
  Si la interfaz de staging montaba bajo la sesión del principal A e iniciaba la hidratación de mensajes, pero el usuario autenticaba como principal B antes de completar la petición de mensajes de A, la respuesta diferida de A ejecutaba su callback y sobrescribía el estado de mensajes activo bajo la sesión B. El flag `active` sólo protegía contra desmontaje del componente, no contra generaciones de sesión o cambios de conversación.
- **Remediación**:
  - **Session Generation Tracking**: Se introdujo `sessionGenerationRef` en `src/routes/TmCommStaging.tsx`. Cada inicio de autenticación incrementa la generación y cancela cualquier controlador de aborto previo (`hydrationAbortRef.current?.abort()`).
  - **Limpieza Inmediata de Estado**: Al cambiar de sesión, se limpian sincrónicamente `conversation`, `conversations`, `messages` y `activeConversationIdRef.current`.
  - **Fencing en Continuaciones Asíncronas**: Antes de invocar cualquier `setConversations`, `setConversation`, `setMessages` o `append(log)`, se comprueba rigurosamente `if (targetSessionGen !== sessionGenerationRef.current) return`.
  - **Aislamiento de Errores 401**: Un 401 recibido durante la hidratación sólo limpia el estado si corresponde a la generación activa. Un 401 retrasado proveniente de una sesión previa es descartado sin alterar el estado válido de la sesión actual.
  - **Protección de Selección de Conversación**: Las peticiones de historial están cercadas con `messageRequestGenRef` y `activeConversationIdRef` para garantizar que respuestas lentas de una conversación previa no sobrescriban la conversación recién seleccionada.
  - **Cancelación Limpia en Cliente HTTP**: En `src/routes/tmCommStagingClient.ts`, `tmCommRequest` captura gracefulmente `AbortError` y cancelaciones de señal, evitando excepciones no controladas.
- **Tests agregados en `src/routes/TmCommStaging.test.tsx`**:
  - Respuestas diferidas de mensajes de sesión A se descartan completamente al autenticar sesión B; la UI muestra únicamente B, los mensajes de A nunca reaparecen, y el log local no inserta contenido sensible de A.
  - Petición pendiente de conversaciones de sesión A se ignora al completar sesión B.
  - Clics rápidos de autenticación (A → B → C) conservan únicamente la generación más reciente C.
  - Cambio de conversación mientras el historial anterior está pendiente descarta el historial obsoleto.
  - Error 401 retrasado de sesión previa no invalida ni limpia el estado válido de la sesión activa actual.
  - Desmontaje del componente cancela de forma limpia las peticiones en curso sin warnings de React.

---

## Final Remediation Pass 3 (Codex Finding P2-7)

El fresh Codex review ejecutado sobre el exact HEAD `f47f5fedb4195803d66622ddce76a137de72f12a` identificó 1 finding P2 pendiente en `scripts/tm-comm-staging-up.ts:20`. Ha sido formalmente remediado en `44e26fb2996d933ca94d13e3135a511fe1e36067` conservando todas las remediaciones previas y las invariantes de arquitectura de TM-COMM A0:

### P2-7: Preserve the operator identity across staging restarts (`PRRC_kwDOQYWUus7xnYbm` / Thread `PRRT_kwDOQYWUus6kApH7`)
- **Causa raíz**:
  Al reiniciar el servidor staging mediante `npm run tm-comm:staging` contra una base de datos SQLite preexistente en `.tmp/`, el script `scripts/tm-comm-staging-up.ts` generaba incondicionalmente un nuevo par de llaves efímero mediante `createTmCommEphemeralWallet()`. El archivo `operator-wallet.json` contenía únicamente campos públicos (`address`, `publicKeyHex`) pero omitía la llave privada, haciendo imposible reconstituir la identidad original. Mientras tanto, `bootstrapTmCommStaging` retenía el `operatorPrincipal` original almacenado en SQLite. Al autenticarse el nuevo par de llaves tras el reinicio, `store.findPrincipalByAddress(newAddress)` no encontraba coincidencia y creaba un nuevo Principal de tipo `customer`, provocando la pérdida total de acceso a las conversaciones donde participaba el operador y la incapacidad de emitir recibos de entrega/lectura legítimos (`delivered`/`read`).
- **Remediación**:
  - **Persistencia de Credencial Fixture**: Se almacena la credencial del operador staging de forma determinista y segura en `.tmp/tm-comm-staging/operator-wallet.json` con permisos de archivo estrictos `0o600` (y directorio `0o700`).
  - **Resolutor de Credencial con Garantías Fail-Closed**: Se implementó `resolveTmCommOperatorCredential` en `server/tmComm/tmCommTestUtils.ts` cubriendo los 5 casos de ciclo de vida:
    1. *Directorio nuevo / base limpia + archivo ausente*: Genera un par de llaves secp256k1 determinista, escribe `operator-wallet.json` con modo `0o600` y registra al operador en base de datos.
    2. *Base existente + archivo presente y válido*: Carga la credencial, verifica que la llave privada sea un escalar secp256k1 válido, valida consistencia interna (address y publicKeyHex derivados), y comprueba que coincida exactamente con el `operatorPrincipal` almacenado en SQLite.
    3. *Base existente + archivo ausente*: **Falla cerrado**. Arroja un error explícito impidiendo la generación silenciosa de un operador sustituto sobre una base con historial activo.
    4. *Archivo corrupto*: **Falla cerrado**. Arroja un error explícito ante JSON truncado/inválido, falta de campo `secretHex`, escalar fuera de rango o alteración de campos derivados.
    5. *Credencial con identidad divergente*: **Falla cerrado**. Arroja un error explícito si la llave deriva una dirección distinta a la del operador almacenado en la base de datos.
  - **Defensa en Profundidad en el Servicio de Bootstrap**: En `server/tmComm/tmCommBootstrap.ts`, `bootstrapTmCommStaging` comprueba explícitamente que si existe un `operatorPrincipal` previo en la base de datos, sus propiedades `walletAddress` y `publicKeyHex` coincidan de forma idéntica con el operador suministrado. De existir discrepancia, arroja `TmCommError(CONFLICT, 409, 'OPERATOR_IDENTITY_MISMATCH')`.
  - **Alineación del Arnés de Staging**: En `scripts/tm-comm-staging-up.ts`, se reemplazó la invocación a ciegas de `createTmCommEphemeralWallet()` por `resolveTmCommOperatorCredential({ credentialPath, store })`.
  - **Protección del Material Secreto**: El secreto jamás ingresa a Git (`.tmp/` está en `.gitignore`), jamás se imprime en la salida de consola/logs de staging, jamás se incluye en `bootstrap-receipt.json`, jamás se transmite al navegador y utiliza permisos `0o600`.
- **Archivos modificados**:
  - `server/tmComm/tmCommTestUtils.ts`
  - `server/tmComm/tmCommBootstrap.ts`
  - `scripts/tm-comm-staging-up.ts`
- **Tests agregados**:
  - `server/tmComm/tmCommRestart.test.ts` (5 pruebas exhaustivas):
    1. *Ciclo completo de reinicio y durabilidad*: Inicia staging → bootstrap de operador → cliente se enrola y asocia conversación → cliente envía mensaje (`accepted`) → parada controlada del servidor y almacenamiento → reinicio sobre la misma base `.tmp` → restauración de credencial idéntica → autenticación como el mismo `operatorPrincipal` (0 creación de Principal cliente) → listado de la misma conversación → acceso a historial del mensaje → emisión legítima de recibos `delivered` y `read` (`status: read`, HTTP 200).
    2. *Credencial ausente + base nueva*: Permite bootstrap inicial y escribe `operator-wallet.json` con permisos `0o600`.
    3. *Credencial ausente + base existente*: Falla cerrado con error descriptivo y conserva el operador original intacto.
    4. *Credencial corrupta*: Falla cerrado en todas las modalidades de corrupción (sintaxis JSON, tipo no-objeto, campo faltante, escalar secp256k1 inválido, dirección adulterada).
    5. *Credencial de otra identidad*: Falla cerrado en el resolutor y en `bootstrapTmCommStaging` arrojando `OPERATOR_IDENTITY_MISMATCH` (409).

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

## Resultados de tests post-remediación (HEAD actual tras Pass 7)

| Comando | Exit | Clasificación |
| --- | --- | --- |
| `npm run typecheck` | 0 | **PASS** (0 errores) |
| `npm run build` | 0 | **PASS** (compilación limpia para producción) |
| TM-COMM focalizado (`npm run test:tm-comm`) | 0 | **PASS** (6 files / 98 tests) |
| Architecture/boundary (`privateMessaging.architecture.test.ts`) | 0 | **PASS** (8/8) |
| Staging restart durability (`tmCommRestart.test.ts`) | 0 | **PASS** (28/28) |
| `npm test` suite vigente | 0 | **PASS** (150 files / 2747 vitest + 10 node:test) |
| `npm run test:tm1-regtest-e2e` | 20 | **ENVIRONMENTAL FAILURE** (preexistente en BASE y HEAD; requiere chronik local en :3000) |
| `npm run lint` BASE | 1 | **FAIL preexistente en BASE** (328 errors / 0 warnings) |
| `npm run lint` HEAD | 1 | **PRE-EXISTING BASELINE FAILURE / DIFFERENTIAL CLEAN** (328 errors / 0 warnings; NEW=0; 0 en TM-COMM) |

Stderr en tests que pasan (no FAIL): `QuotaExceededError` esperado en RegisterAlias; WASM fallback en x402Activation.

---

## Staging URL

- API: http://127.0.0.1:4178/v1/tm-comm/health → `{"ok":true,"environment":"staging","protocol":"tm-comm","version":1,"financialAuthority":false,"memoPublication":false}`
- UI: http://127.0.0.1:5174/tm-comm-staging → 200

---

## Riesgos residuales

1. **Tokens y credencial fixture en `.tmp/`**: Se almacenan tokens de desarrollo, la base SQLite local y la credencial ficticia de staging del operador en `.tmp/tm-comm-staging/` con permisos `0o600` (directorio `0o700`), no versionados en git.
2. **Ambiente de staging local**: Cookies sin atributo `Secure` en HTTP local `127.0.0.1:4178`; sin rate-limiting de producción.
3. **Ficticio y aislado**: Entorno estrictamente acotado a staging; operador fixture en bootstrap; email e IA fencados (no implementados).
4. **328 lint findings históricos**: Preexisten en BASE en módulos fuera de TM-COMM (`Tonalli Memo`, `Agent Wallet Execution`, `Trusted Wallet Runtime`, `MemoCompose`, `aliasDiscovery`). Cero findings en archivos TM-COMM.

---

## GO / NO-GO para Fresh Codex Review

**GO: READY FOR FRESH CODEX REVIEW (PASS 7)**
- **Findings P2 remediados formalmente**:
  - P2-1: Validación client-side exhaustiva del challenge antes de invocar `signMessage`.
  - P2-2: Enforce estricto de origin en todas las mutaciones autenticadas con auditoría `ORIGIN_MISMATCH` y rechazo 415 a bypasses sin `application/json`.
  - P2-3: Prohibición de receipts propios del remitente (403 `SELF_RECEIPT_FORBIDDEN`), rechazo a impersonación (403 `RECEIPT_IMPERSONATION`) y derivación estricta de estado a partir de los destinatarios.
  - P2-4: Restauración determinista de conversaciones e historial durable en reload/mount, selector UI multiconversación y estado limpio en 401 sin uso de `localStorage`.
  - P2-5: Fijación estricta de `expectedSessionContext` (`tm-comm-a0-staging:v1`) en cliente contra configuración confiable local, con fail-closed y 0 llamadas a `signMessage` ante cualquier discrepancia.
  - P2-6: Incorporación de `replyToId` normalizado en la identidad idempotente con atomicidad transaccional SQLite (`BEGIN IMMEDIATE`), replay idempotente garantizado y rechazo 409 `IDEMPOTENCY_CONFLICT` inmutable ante variaciones.
  - P2-7: Persistencia determinista de la identidad del operador entre reinicios staging en `.tmp/tm-comm-staging/operator-wallet.json` (`0o600`), verificación estricta contra `operatorPrincipal` en SQLite, protección contra sustitución silenciosa y rechazo fail-closed ante credenciales ausentes o corruptas (409 `OPERATOR_IDENTITY_MISMATCH`).
  - P2-8: Creación atómica y exclusiva de la credencial de operador (`O_CREAT | O_EXCL` / flag `wx`) con permisos `0600` y reintento con backoff exponencial para el perdedor (`EEXIST`), recargando la credencial ganadora sin truncar ni regenerar.
  - P2-9: Clasificación de `operator-wallet.json` como material criptográfico sensible / staging secret en documentación de seguridad, documentando invariante de infraestructura de fixtures.
  - P2-10: Fencing estricto de generación de sesión (`sessionGenerationRef`) con `AbortController` en el cliente React de staging, garantizando descarte inmediato de respuestas tardías o 401s obsoletos de sesiones anteriores.
  - P2-11: Limpieza síncrona inmediata de mensajes (`setMessages([])`) al cambiar de conversación con invalidación/abort de peticiones previas (`messageAbortRef`, `messageRequestGenRef`), asegurando que jamás se muestren mensajes del chat anterior mientras el nuevo fetch está pendiente o falla.
  - P2-12: Enforce estricto de permisos `0700` en el directorio padre de la credencial del operador en todos los caminos de `resolveTmCommOperatorCredential` (incluyendo reinicios con credencial preexistente) antes de cualquier return, con verificación `statSync` y fail-closed ante discrepancias.
  - P2-13 (Pass 6): Eliminación completa de dependencia de permisos del host (`/root/`); simulación determinista de fallos de filesystem (`EACCES`/`EPERM`) mediante mock ESM hoisted (`vi.mock('node:fs')`), verificación de invocación del mock, contención estricta en `makeTempDirectory()`, fail-closed sin generación de identidades sustitutas y cleanup exhaustivo.
  - P2-14 (Pass 7): Eliminación de comportamientos best-effort en la asignación de permisos `0600` a `operator-wallet.json`. Implementación de `ensureSecureCredentialFile` con aplicación mandatoria de `chmodSync(..., 0o600)`, verificación síncrona mediante `statSync`, y fail-closed inmediato ante cualquier error (`EACCES`, `EPERM`, error en `statSync` o modo distinto de `0600`). Se ejecuta en todos los caminos: creación nueva, carga de credencial preexistente y recarga ganadora tras `EEXIST`, garantizando que ninguna rama retorne una wallet ni registre un `operatorPrincipal` si la verificación no concluye con éxito.
  - P2-15 (Pass 8): Coherencia estricta wallet ↔ sesión TM-COMM en cliente React (`TmCommStaging.tsx`). Introducción de `authenticatedWalletAddress`, verificación de sesión persistente contra `GET /v1/tm-comm/me`, purga reactiva inmediata de conversaciones, mensajes y generaciones ante cambio de `address` o bloqueo de wallet, guards síncronos fail-closed en `bind`, `send` y `refreshMessages`, e inhabilitación de controles UI para evitar filtración de historial o consumo no intencionado de tokens.
  - P2-16 (Pass 8): Compuerta de compatibilidad estricta de metadata SQLite en `TmCommStore`. Detección de base nueva vs preexistente; rechazo fail-closed inmediato (`TmCommMetadataMismatchError`) ante bases de datos ajenas sin `tm_comm_metadata` o con discrepancias en `schema_version`, `application_id` o `environment`, impidiendo la adopción silenciosa o corrupción de esquemas incompatibles antes de cualquier mutación o bootstrap; y cierre garantizado del handle SQLite en el constructor.
- **Validación 100% verde**:
  - `npm run typecheck`: PASS (código 0)
  - `npm run build`: PASS (código 0)
  - `npm run test:tm-comm`: PASS (6 archivos, 118 tests)
  - `src/features/privateMessaging/privateMessaging.architecture.test.ts`: PASS (8/8)
  - `server/tmComm/tmCommRestart.test.ts`: PASS (39/39)
  - `src/routes/TmCommStaging.test.tsx`: PASS (37/37)
  - `npm test`: PASS (150 archivos, 2766 vitest + 10 node:test)
  - `npm run lint`: PRE-EXISTING BASELINE FAILURE / DIFFERENTIAL CLEAN (NEW findings = 0; 328 preexistentes en BASE, 328 en HEAD, 0 en archivos TM-COMM)
- **Invariantes arquitectónicas preservadas**:
  - Cero OpenAI, cero clientes reales, cero fondos reales, cero autoridad financiera, cero Agent Wallet authority, cero settlement, cero broadcast, cero sendXec, cero eToken movement, cero auto-publicación en Tonalli Memo.
  - Sin merge a main, sin avance a M1, sin ampliación de scope.

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
