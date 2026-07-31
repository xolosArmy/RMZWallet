# `/external-sign` P0: aprobación humana y firma sin transmisión

Base normativa: `Tonalli_Wallet_Especificacion_Tecnica_External_Sign_P0_v2_2026-07-31.md`, SHA-256 `308074d1b1ed6f4a3e5413b1bcca16bab1179959fe7374b15fd7e2bf708531e8`.

## Estado operativo

`/external-sign` está deshabilitado por defecto. La configuración normal usa:

```dotenv
VITE_EXTERNAL_SIGN_P0_ENABLED=false
VITE_EXTERNAL_SIGN_ALLOWED_ORIGINS=
```

La función solo puede montarse si el flag vale exactamente `true` y la allowlist contiene uno o más orígenes HTTPS canónicos. Este repositorio no habilita ningún origen real. Las pruebas inyectan exclusivamente `https://fixture.invalid` y mocks locales.

## Contrato y perímetro

El contrato wire v1 es cerrado. Acepta únicamente `protocolId: tonalli.external-sign`, `protocolVersion: 1`, `chainId: ecash:1` y `mode: signOnly`. Rechaza campos desconocidos, miembros JSON duplicados, `broadcast`, `signAndBroadcast`, modalidades omitidas o desconocidas y codificaciones distintas de base64url sin padding.

El revisor acepta solo XEC puro: inputs P2PKH de la wallet activa y hasta 10 outputs P2PKH, con máximo un output de cambio. Tokens, NFTs, P2SH, multifirma, OP_RETURN, scripts desconocidos y datos no interpretables fallan cerradamente.

Los fees se calculan como `prevouts - outputs`. La tasa usa el tamaño firmado P2PKH proyectado —100 bytes de script de desbloqueo por input— y el resultado firmado se vuelve a verificar contra ese tamaño y los mismos inputs/outputs. Deben cumplirse simultáneamente:

- mínimo 1 sat/byte;
- máximo 10 sat/byte;
- máximo absoluto 10,000 sats (100 XEC).

Los límites son constantes internas y el payload no puede configurarlos.

## Frontera de aprobación

La UI y el `contentHash` consumen la misma revisión derivada de los bytes exactos de `unsignedTxHex`. El clic crea una capacidad de aprobación de un solo uso, vinculada al contenido exacto y mantenida únicamente en memoria. Antes de acceder al signatory se vuelven a decodificar los bytes, obtener prevouts, calcular el resumen y calcular el hash. La capacidad se consume con compare-and-set local y un tombstone único en IndexedDB bajo un Web Lock exclusivo.

Una recarga, navegación, rechazo, cancelación, expiración, cambio de contenido o error del replay store invalida la capacidad. `sessionStorage` solo conserva la solicitud durante onboarding y se consume con take-and-delete.

Este control no protege una aplicación ya comprometida por XSS, una extensión maliciosa, un navegador comprometido o una cadena de suministro sustituida.

## Broadcast y compatibilidad

El módulo `signOnly.ts` no importa Chronik y no recibe una interfaz de broadcast. La ruta entrega únicamente `signedTxHex`; no existe llamada a `broadcastTx` en el flujo P0.

Web Crypto, IndexedDB, Web Locks y BroadcastChannel son obligatorios. La ausencia de cualquiera deshabilita la operación; no hay fallback.

## Pruebas y rollback

`p0Matrix.test.ts` contiene 39 casos negativos (`N01`–`N39`) y cuatro positivos exclusivamente `signOnly` (`P01`–`P04`). `architecture.test.ts` comprueba la separación signer/broadcast, el orden revalidación → consumo → firma, la ausencia de persistencia de capacidades y la configuración default-off.

El rollback seguro consiste en mantener `VITE_EXTERNAL_SIGN_P0_ENABLED=false` y la allowlist vacía. Nunca se restaura el componente anterior que firmaba automáticamente. Dashboard, onboarding y las demás rutas de la wallet permanecen disponibles.
