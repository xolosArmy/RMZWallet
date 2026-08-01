# Núcleo universal de autorización para firma externa

## Estado y alcance

Este PR contiene un núcleo universal, inerte y agnóstico de protocolo. No contiene un perfil funcional para XEC ni para otro protocolo. El merge integra esta infraestructura inerte y elimina la antigua ruta automática de firma y broadcast; no activa external signing.

La ruta `/external-sign` permanece deshabilitada, monta únicamente `ExternalSignDisabled`, muestra `EXTERNAL_SIGN_DISABLED` y no instancia el núcleo.

La configuración normal permanece:

```dotenv
VITE_EXTERNAL_SIGN_P0_ENABLED=false
VITE_EXTERNAL_SIGN_ALLOWED_ORIGINS=
```

Las variables se conservan como evidencia operativa de contención. El registro de perfiles productivos permanece vacío y ninguna configuración incluida registra o habilita un perfil funcional.

## Gate de integración

```text
INTEGRATION GATE: AUTHORIZED BY INTERNAL PROJECT CONTROL

La integración del núcleo universal inerte está autorizada por Fernando bajo el control interno de xolosArmy.

Esta autorización no habilita perfiles productivos, external signing, signatory real, entrega automática, broadcast ni acciones on-chain.

La producción permanece deshabilitada y cualquier capacidad operativa futura requiere un PR y autorización separados.
```

La autoridad de integración corresponde a Fernando y al control interno de xolosArmy. No se requiere revisión humana ni revisión independiente adicional. El núcleo universal fue evaluado mediante criterios técnicos objetivos y su integración está autorizada dentro de los límites documentados.

## Frontera universal

El envelope v1 es cerrado y contiene solo identidad de operación, perfil declarado, vigencia y solicitante. `start()` recibe `unknown` y siempre ejecuta internamente `parseUniversalAuthorizationEnvelope`; un cast estructural de TypeScript no puede omitir esquema, versión, timestamps, normalización, cierre del objeto ni validación del origen declarado. El `contentHash` usa separación de dominio y compromete exclusivamente el envelope universal canónico y los bytes efectivos entregados por el adaptador.

`requester.declaredOrigin` es un origen declarado y normalizado, no una identidad autenticada. El núcleo no demuestra qué ventana, transporte o principal originó la solicitud; un host futuro deberá autenticar ese vínculo por separado y nunca presentar el campo como identidad verificada.

El núcleo no interpreta activos, scripts, comisiones, cambios, salidas, metadata ni proveedores de red. Los contratos están separados únicamente en `prepareReview`, `revalidateReview` y `signApprovedContent`. Las pruebas inyectan exclusivamente un adaptador sintético; el registro productivo está vacío.

## Ciclo de vida y propiedad

Las transiciones positivas son explícitas:

```text
disabled
→ receiving
→ preparing
→ reviewReady
→ approving
→ revalidating
→ signing
→ completed
```

Antes de `signing`, los terminales negativos son `rejected`, `expired`, `aborted` y `failed`. Cada continuación previa a firma valida `operationId`, estado esperado, `AbortSignal`, vigencia y propiedad del lease. El guard de operación se instala sincrónicamente antes del primer `await`.

Un solo contexto posee el `operationId`, `AbortController`, capacidad, lease, cleanup y finalización. El lease se adquiere antes de preparar y se conserva hasta un terminal. La finalización es idempotente y solo el propietario puede liberar su lease.

Navegación, recarga, desmontaje o sustitución deben invocar `abort` o `replace` en el host futuro. El aborto invalida la capacidad, cancela continuaciones, libera el lease y limpia referencias. La ruta actual no monta un host porque permanece deshabilitada.

## Firma y punto de no retorno

El adaptador de firma solo se invoca después de aprobación explícita, revalidación, igualdad del hash, consumo atómico de la capacidad y nuevas comprobaciones de señal, estado, vigencia y lease. El resultado representa bytes firmados y una etiqueta de formato.

`signing` es el punto de no retorno. Desde que se invoca `signApprovedContent`, la operación solo puede terminar en `completed` o `failed`; un aborto, rechazo, desmontaje o vencimiento posterior no se reclasifica como `aborted` o `expired`. El `AbortSignal` sigue notificando cancelación cooperativa al adaptador, pero no garantiza cancelar un efecto criptográfico ya iniciado. El lease se conserva hasta que la promesa del signer se resuelve o rechaza.

```text
signing → completed
signing → failed
```

El flujo termina en `completed`, libera el lease y devuelve el resultado firmado desde `approve()`. No hay callback de entrega. Entrega a una dApp, `postMessage`, almacenamiento, red o cualquier receptor será una capacidad futura separada y queda fuera de este núcleo.

```text
acquire
→ prepare
→ review
→ approve
→ revalidate
→ consume
→ sign
→ completed
→ release
→ devolver resultado
```

El núcleo no acepta transmisores, no importa servicios de wallet, proveedores de indexación ni librerías de protocolo, y no entrega ni difunde automáticamente el resultado.

## Contención productiva y límites de alcance

No existe conexión con Chronik, `XolosWalletService`, `ecash-lib`, signatory real, entrega automática o broadcast. WalletConnect no fue modificado y permanece fuera del alcance de este PR.

Cualquier perfil XEC, RMZ, ALP, NFT, `OP_RETURN`, multisig o capacidad de transmisión requerirá un trabajo separado, un PR separado y autorización nueva. El merge no habilita un host productivo ni altera variables de entorno, perfiles de autorización o mecanismos de transmisión.

## Validación y excepción ambiental

Las pruebas usan fake timers, promesas controladas y contextos sintéticos sin red. El núcleo universal fue evaluado mediante criterios técnicos objetivos, incluidos typecheck, lint, pruebas focalizadas, build y las suites registradas en la descripción del PR.

La excepción ambiental de `npm test` fue evaluada y aceptada conscientemente: el comando agregado terminó con exit 1; Vitest pasó 201/201; la suite NFT pasó 4/4 mediante `node --import tsx --test`; y la causa registrada fue el socket IPC de `tsx` bloqueado por el sandbox. `npm test` no debe describirse como un comando aprobado.

## Evidencia requerida antes de producción

La evidencia cross-tab se limita todavía a contextos simulados. La evidencia cross-tab en navegador real será obligatoria antes de habilitar un host o perfil productivo, pero no bloquea el merge del núcleo inerte.

El rollback seguro consiste en conservar la ruta deshabilitada. La integración documental y del núcleo inerte está autorizada; cualquier activación, perfil productivo, signatory real, entrega, broadcast o acción on-chain futura requiere un PR y autorización separados.
