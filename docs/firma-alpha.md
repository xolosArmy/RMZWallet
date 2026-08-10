# Firma Alpha en el DEX

Tonalli Wallet integra exclusivamente el mercado on-chain `XEC ↔ FIRMA` mediante covenants parciales de `ecash-agora`. Esta integración no incluye bancos, transferencias fiat, KYC, ACH, wire, stablecoins ni puentes a otras cadenas.

## Identidad canónica

La aplicación nunca identifica FIRMA por ticker o nombre solamente. La configuración en `src/config/firmaAlpha.ts` exige simultáneamente:

- Token ID: `0387947fd575db4fb19a3e322f635dec37fd192b5941625b66bc4b2c3008cbf0`;
- protocolo `ALP`;
- tipo estándar `0` (`ALP_TOKEN_TYPE_STANDARD`);
- `4` decimales;
- ticker on-chain `FIRMA` y nombre on-chain `Firma`;
- clave de autoridad de la génesis `03fba49912622cf8bb5b3729b1b5da3e72c6b57d369c8647f6cc7c6cbed510d105`.

Antes de consultar el mercado o construir una transacción, Chronik vuelve a cargar la génesis y valida esos campos. Los saldos solo suman UTXOs no-baton cuyo Token ID, protocolo y tipo coinciden exactamente. Un token distinto que use el ticker `FIRMA` no aparece como Firma Alpha.

Fuentes de verificación:

- sitio oficial: `https://firmaprotocol.com/`;
- génesis en el explorer: `https://explorer.e.cash/tx/0387947fd575db4fb19a3e322f635dec37fd192b5941625b66bc4b2c3008cbf0`;
- identidad y redención de referencia: `cashtab/src/constants/tokens.ts` y `cashtab/src/components/Etokens/Token/index.tsx` en Bitcoin ABC;
- endpoints Agora de referencia: `cashtab/src/config/chronik.js` en Bitcoin ABC.

## Balance FIRMA

El escaneo HD existente suma FIRMA junto con XEC y RMZ para las ramas receive/change y conserva las cantidades en `bigint`. El fallback de la billetera usa los mismos 4 decimales canónicos. Agregar FIRMA no modifica la selección, envío o fee de RMZ, NFT o Mint Pass.

## Descubrimiento y protección del mercado

`discoverFirmaOffers` consulta `Agora.activeOffersByTokenId` en el Chronik configurado, sin RPC. Una oferta visible debe:

1. estar `OPEN` y ser `PARTIAL`;
2. bloquear exactamente el Token ID FIRMA canónico;
3. ser ALP estándar, no baton y tener una cantidad positiva consistente;
4. pertenecer a la clave pública del minter oficial (las ofertas propias solo se admiten cuando se pasa explícitamente la clave de la wallet);
5. superar la validación del covenant y del output P2SH al preparar la compra.

Las ofertas válidas se ordenan por precio usando aritmética racional con `bigint`, sin convertir cantidades financieras a `number`. La primera versión consume una sola oferta por compra; si ninguna oferta individual cubre la cantidad, la interfaz informa liquidez insuficiente en vez de producir un swap parcial inesperado.

El endpoint Chronik debe tener cargado el plugin Agora. Se configura de forma aislada con `VITE_AGORA_CHRONIK_URL` (lista separada por comas) o `AGORA_CHRONIK_URL`; por defecto se usan los nodos Agora publicados en la configuración vigente de Cashtab. `VITE_CHRONIK_URL`/`CHRONIK_URL` siguen controlando consultas generales y broadcast. Si el plugin responde `404`, la UI muestra el estado explícitamente y no sustituye el descubrimiento con IDs históricos ni con un servidor RPC.

## Comprar Firma

1. El usuario introduce la cantidad FIRMA.
2. La wallet descubre la mejor oferta oficial compatible.
3. Chronik vuelve a cargar la transacción, comprueba que el output no esté gastado y reconstruye el covenant.
4. La pantalla muestra cantidad efectiva, XEC al maker, comisión, total, Offer ID y dirección de pago.
5. Solo después de una confirmación explícita se vuelve a validar la misma cotización, se seleccionan UTXOs XEC puros, se firma localmente y se transmite por Chronik.

Si Agora ajusta la cantidad por granularidad, el preview lo indica. Una oferta gastada, modificada o con otro maker obliga a generar un preview nuevo.

## Vender Firma

Vender crea una oferta parcial ALP de una sola transacción. El usuario define cantidad y precio en XEC por FIRMA. El preview muestra FIRMA bloqueada, XEC a recibir al completarse, precio efectivo, comisión, cambio FIRMA e inputs seleccionados. La confirmación reconstruye el plan; si los UTXOs cambiaron, se cancela la firma y se exige otro preview.

La publicación bloquea FIRMA en el covenant Agora; no garantiza que exista un comprador. La oferta permanece cancelable por la llave que la creó, aunque la UI de cancelación dedicada queda fuera de esta primera integración.

## Redimir Firma a XEC

“Redimir” mantiene el mecanismo oficial on-chain de Firma:

- obtiene el bid vigente desde `https://firmaprotocol.com/api/bid`;
- consulta el saldo XEC de la dirección oficial de redención;
- exige un mínimo de `0.01 FIRMA`;
- crea una oferta Agora por el monto completo, ajustada estrictamente por debajo del bid cuando la granularidad del covenant lo exige;
- impide publicar si la hot wallet no cubre la redención inmediata.

El resultado no es un retiro fiat: es una oferta FIRMA por XEC que el sweeper oficial puede aceptar on-chain. Tonalli Wallet no custodia fondos, no envía llaves o seed y no promete tiempo de ejecución fuera de la confirmación de red.

## Frontera de firma

El preview utiliza datos públicos, UTXOs y scripts. Las llaves privadas solo se obtienen del servicio local de wallet dentro de la fase de confirmación. La transacción firmada se transmite directamente a Chronik. Ningún endpoint de Firma, Agora o documentación recibe seed, clave privada o material de firma.

## Errores esperados

- plugin Agora ausente;
- génesis o metadata FIRMA inconsistente;
- oferta gastada o cambiada;
- maker no oficial o token falso;
- cantidad inferior al mínimo o granularidad no representable;
- liquidez FIRMA insuficiente;
- XEC insuficiente para precio, dust o comisión;
- FIRMA insuficiente en la dirección activa;
- bid o capacidad de redención no disponibles;
- fallo de red, indexación o broadcast.

## Prueba manual on-chain

No se ejecuta automáticamente con fondos reales. En una wallet de prueba respaldada:

1. abre `/dex?mode=firma` o configura `VITE_AGORA_CHRONIK_URL` con otro Chronik mainnet que tenga el plugin Agora;
2. comprueba que el Token ID visible coincide exactamente con la génesis;
3. compra una cantidad pequeña y verifica preview, TXID y aumento de balance;
4. publica una venta pequeña, verifica el output `txid:1` y su aparición en Agora;
5. con capacidad suficiente del sweeper, prepara una redención de al menos `0.01 FIRMA`, compara bid/precio efectivo y confirma;
6. verifica en el explorer que las tres firmas y broadcasts fueron on-chain;
7. repite los smoke tests de RMZ, NFT, Mint Pass y WalletConnect.

## Diferencias con la documentación histórica

Los PDFs históricos describen el DEX completo como “oneshot por Offer ID” y proponen infraestructura propia futura. El `main` actual ya contiene ofertas parciales ALP para RMZ y `ecash-agora`; por eso Firma Alpha se implementa sobre esos covenants actuales. NFT y Mint Pass conservan el flujo oneshot existente. No se recuperó ni reutilizó código o commits de ejecuciones anteriores.
