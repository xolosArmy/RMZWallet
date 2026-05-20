# Pinata backend seguro

Las credenciales de Pinata ya no deben vivir en `src/` ni en variables `VITE_*`.

## Variables de entorno

Configura esta variable solo del lado servidor:

- `PINATA_JWT`

Configura esta variable pública solo si quieres un gateway IPFS personalizado en el cliente:

- `VITE_IPFS_GATEWAY`

## Despliegue

### Vercel

- La función vive en `api/pinata/upload.ts`.
- Agrega `PINATA_JWT` en el dashboard de Vercel para los entornos necesarios.

### Netlify

- La función vive en `netlify/functions/pinata-upload.ts`.
- `netlify.toml` redirige `/api/pinata/upload` hacia `/.netlify/functions/pinata-upload`.
- Agrega `PINATA_JWT` en el dashboard de Netlify para los entornos necesarios.

## Desarrollo local

Si quieres seguir usando `vite` directamente, puedes proxyar `/api` hacia tu runtime serverless:

- Vercel: `VITE_API_PROXY_TARGET=http://localhost:3000` y `VITE_API_PROXY_PROVIDER=vercel`
- Netlify: `VITE_API_PROXY_TARGET=http://localhost:8888` y `VITE_API_PROXY_PROVIDER=netlify`

Con Netlify también puedes usar `netlify dev`, que aplica la función y el redirect localmente.
