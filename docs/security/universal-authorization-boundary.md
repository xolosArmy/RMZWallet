# Núcleo universal de autorización para firma externa

## Estado y alcance

Este Draft PR contiene un núcleo experimental, universal y agnóstico de protocolo. No contiene un perfil funcional para XEC ni para otro protocolo. La ruta `/external-sign` siempre muestra `EXTERNAL_SIGN_DISABLED` y no instancia el núcleo.

La configuración normal permanece:

```dotenv
VITE_EXTERNAL_SIGN_P0_ENABLED=false
VITE_EXTERNAL_SIGN_ALLOWED_ORIGINS=
```

Las variables se conservan como evidencia operativa de contención; ninguna configuración incluida en este PR registra o habilita un perfil productivo.

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

## Evidencia pendiente

Las pruebas usan fake timers, promesas controladas y contextos sintéticos sin red. La evidencia cross-tab se limita todavía a contextos simulados. Antes de activar cualquier perfil siguen pendientes una prueba en navegador real, revisión humana independiente y un gate de seguridad separado.

El rollback seguro consiste en conservar la ruta deshabilitada. Este PR no autoriza merge, activación, despliegue ni acciones on-chain.
