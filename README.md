# RMZWallet

Tonalli RMZWallet (Vite + React + TypeScript) para eCash (XEC).

## Variables de entorno

Configura estas variables en Vercel o tu entorno local:

- `VITE_PINATA_JWT` (recomendado) o `VITE_PINATA_API_KEY` + `VITE_PINATA_SECRET`
- `VITE_PINATA_GATEWAY` (opcional) para render de imágenes IPFS
- `VITE_XOLOSARMY_NFT_PARENT_TOKEN_ID` (token padre NFT1 Group)
- `VITE_NFT_MINT_FEE_RECEIVER_ADDRESS` (tesorería para el fee de minteo)
- `VITE_WALLETCONNECT_PROJECT_ID` (principal, requerido para WalletConnect v2)
- `VITE_WC_PROJECT_ID` (legacy compatible; fallback si falta la principal)
- `VITE_WC_ALLOWED_DOMAINS` (opcional, lista CSV para warning anti-phishing en UI)

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
