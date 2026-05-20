# RMZWallet

Tonalli RMZWallet (Vite + React + TypeScript) para eCash (XEC).

## Variables de entorno

Configura estas variables en Vercel o tu entorno local:

- `PINATA_JWT` en el entorno del servidor, sin prefijo `VITE_`
- `VITE_IPFS_GATEWAY` (opcional) para render de imágenes IPFS
- `VITE_XOLOSARMY_NFT_PARENT_TOKEN_ID` (token padre NFT1 Group)
- `VITE_NFT_MINT_FEE_RECEIVER_ADDRESS` (tesorería para el fee de minteo)
- `VITE_WALLETCONNECT_PROJECT_ID` (principal, requerido para WalletConnect v2)
- `VITE_WC_PROJECT_ID` (legacy compatible; fallback si falta la principal)
- `VITE_WC_ALLOWED_DOMAINS` (opcional, lista CSV para warning anti-phishing en UI; sugerido: `teyolia.cash,www.teyolia.cash`)

Las subidas a Pinata ya no salen desde `src/`: el frontend envía `POST /api/pinata/upload` y la función serverless inyecta `PINATA_JWT` en Vercel o Netlify. La guía rápida está en `docs/pinata-backend.md`.

## WalletConnect v2 (CAIP-25)

- Namespace soportado: `ecash`
- Chain estándar soportada: `ecash:1`
- Compat legacy: también se acepta `ecash:mainnet` si la dApp lo propone
- Método principal: `ecash_signAndBroadcastTransaction`
- Método auxiliar: `ecash_getAddresses`
- Accounts CAIP-10: `<chain>:<address>` (preferido `ecash:1:<address>`)

### Errores JSON-RPC expuestos a la dApp

- Usuario rechaza: `{ code: 4001, message: "Rechazado por el usuario." }`
- Params inválidos (`offerId` o `outputs` requeridos): `{ code: -32602, message: "Params inválidos: offerId o outputs requeridos" }`
- Método no soportado: `{ code: -32601, message: "Método no soportado" }`
- Error interno de firma/transmisión: `{ code: -32000, message: "Error al firmar/transmitir" }`

### Validación manual (dev)

- Flujo intent-only: conectar Flipstarter -> Donar -> debe abrir modal de RMZWallet y firmar sin mostrar `Usa el formato txid:vout.` cuando la request solo trae `outputs`.

## NFTs

Ver pruebas manuales sugeridas en `docs/nfts.md`.

## Tonalli Connect sign-message

Tonalli Wallet expone la ruta `/connect/sign-message` para que apps externas, como eCash México Mining Gateway, soliciten una firma de challenge sin exponer llaves privadas. El callback vuelve por hash params con `status`, `address`, `pubkey`, `signature` y `challengeId`.

Detalles y ejemplos: `docs/tonalli-connect-sign-message.md`.
