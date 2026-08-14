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

La `genesisAuthPubkeyHex` autentica la metadata de la génesis; no autoriza makers del mercado. La pubkey de cada maker pertenece al covenant concreto, determina el payout XEC y permite cancelar su propia oferta. No convierte a esa wallet en autoridad sobre FIRMA ni restringe quién puede ofrecer el token.

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
4. contener una pubkey comprimida de maker, una cantidad y un mínimo representables, un precio positivo y un redeem script que coincida byte por byte con el covenant anunciado;
5. superar nuevamente la validación del covenant y del output P2SH al preparar la compra.

El orderbook visible se ordena por el precio indicativo de aceptar cada oferta completa. Esa vista no decide la compra automática. Para la cantidad concreta solicitada, Tonalli ejecuta `prepareAcceptedAtoms` en cada covenant, descarta cantidades no representables, inferiores al mínimo o que fallen `preventUnacceptableRemainder`, calcula `askedSats(preparedAcceptedAtoms)` y compara racionalmente `askedSats / acceptedAtoms` con productos cruzados `bigint`. Un empate se resuelve de forma determinista por Offer ID. Así, un maker no gana prioridad mostrando un precio atractivo para `offeredAtoms` si el redondeo de una aceptación parcial produce un precio efectivo peor.

Cualquier wallet puede publicar una oferta FIRMA canónica: la identidad del maker se etiqueta como `peer`, `propia` u `oficial` solamente si existe una pubkey de liquidez oficial verificada de forma independiente. La etiqueta nunca cambia la validez ni excluye liquidez. La primera versión consume una sola oferta por compra; si ninguna oferta individual cubre la cantidad de forma válida, la interfaz informa el problema en vez de producir un swap parcial inesperado.

El endpoint Chronik debe tener cargado el plugin Agora. Se configura de forma aislada con `VITE_AGORA_CHRONIK_URL` (lista separada por comas) o `AGORA_CHRONIK_URL`; por defecto se usan los nodos Agora publicados en la configuración vigente de Cashtab. `VITE_CHRONIK_URL`/`CHRONIK_URL` siguen controlando consultas generales y broadcast. Si el plugin responde `404`, la UI muestra el estado explícitamente y no sustituye el descubrimiento con IDs históricos ni con un servidor RPC.

## Comprar Firma

1. El usuario introduce la cantidad FIRMA.
2. La wallet cotiza la cantidad solicitada en cada oferta canónica y elige el menor precio efectivo real entre todos los makers.
3. Chronik vuelve a cargar la transacción, comprueba que el output no esté gastado y reconstruye el covenant.
4. La pantalla muestra cantidad efectiva, precio efectivo XEC/FIRMA, XEC al maker, comisión, total, Offer ID y dirección de pago.
5. Solo después de una confirmación explícita se vuelve a validar la misma cotización y se reconstruye la selección de UTXOs XEC puros con `getAgoraPartialAcceptFuelInputs`; si los outpoints difieren del preview se exige otra previsualización antes de acceder a llaves. Después se firma localmente y se transmite por Chronik.

Si Agora ajusta la cantidad por granularidad, el preview lo indica. Una aceptación total con remainder cero es válida; una aceptación parcial solo llega al preview si el remainder conserva el mínimo y valor dust exigidos por el covenant. Una oferta gastada, modificada, con un covenant distinto o con un remainder inaceptable obliga a elegir otra oferta o generar un preview nuevo.

La estimación de comisión usa `getAgoraPartialAcceptFuelInputs`, `DUMMY_KEYPAIR`, `P2PKHSignatory` dummy y el `EccDummy` interno de `acceptFeeSats`. La confirmación reconstruye el mismo plan y usa el mismo helper oficial, en lugar de una segunda estrategia local de coin selection. Descubrimiento, cotización, preparación y preview no llaman `getSignatory`, `withPrivateKey` ni `signTxBuilder`; la llave real solo se materializa después de comparar oferta, cantidad, precio, fee y outpoints actuales con el preview.

## Vender Firma

Vender crea una oferta parcial ALP de una sola transacción. El usuario define cantidad y precio en XEC por FIRMA. Cada candidato final pasa por `new Agora(getAgoraChronik()).selectParams(...)`; la biblioteca selecciona un `enforcedLockTime` pasado y consulta el P2SH para evitar covenants idénticos. Tonalli Wallet no deriva ese valor de `Date.now()/1000` ni lo inventa manualmente. El preview muestra FIRMA bloqueada, XEC a recibir al completarse, precio efectivo, comisión, cambio FIRMA e inputs seleccionados. La confirmación reconstruye el plan, comprueba nuevamente que el covenant siga disponible y, si los UTXOs cambiaron, cancela la firma y exige otro preview.

La publicación bloquea FIRMA en el covenant Agora; no garantiza que exista un comprador. La oferta permanece cancelable por la llave que la creó, aunque la UI de cancelación dedicada queda fuera de esta primera integración.

## Redimir Firma a XEC

“Redimir” mantiene el mecanismo oficial on-chain de Firma:

- obtiene el bid vigente mediante el endpoint same-origin `GET /api/firma-bid` de Tonalli;
- consulta el saldo XEC de la dirección oficial de redención;
- exige un mínimo de `0.01 FIRMA`;
- crea una oferta Agora por el monto completo, ajustada estrictamente por debajo del bid cuando la granularidad del covenant lo exige;
- impide publicar si la hot wallet no cubre la redención inmediata.

La función Edge de Vercel llama server-to-server exclusivamente a `https://stakedxec.com/api/bid`, el upstream vigente de redención que usa la implementación actual de Cashtab. El bundle del navegador no conserva ni consulta esa URL. La función sigue redirects, pero exige que la respuesta final permanezca en el origen autorizado, sea HTTP 2xx y tenga `Content-Type` JSON. Sólo acepta un `bid` decimal positivo representable en satoshis, devuelve `{"bid":"…"}` y marca toda respuesta `Cache-Control: no-store, max-age=0`. No recibe estado de la wallet, no reenvía cookies o autorización y no permite elegir otro upstream.

Tonalli interpreta el `bid` como **XEC por 1 FIRMA** y lo convierte a satoshis sin coma flotante financiera. Timeout, HTTP no exitoso, redirect a otro origen, respuesta HTML, JSON inválido, ausencia de `bid` o precio no positivo abortan la operación. No existe precio fijo, cacheado, sintético ni derivado de Agora como fallback.

`https://firma.cash/api/bid` no es un endpoint alternativo válido: actualmente redirige a `www.firma.cash`, una marca distinta, y termina en HTTP 404. No existe fallback silencioso.

En la confirmación de una redención, antes de materializar la llave, Tonalli vuelve a consultar `/api/firma-bid` y la capacidad del sweeper, reconstruye el plan con los UTXOs actuales y comprueba que el P2SH seleccionado siga libre. Si el bid cambió, la capacidad ya no supera `askedSats`, cambiaron los inputs o apareció un covenant idéntico, la ejecución aborta y exige un preview nuevo.

El resultado no es un retiro fiat: es una oferta FIRMA por XEC que el sweeper oficial puede aceptar on-chain. Tonalli Wallet no custodia fondos, no envía llaves o seed y no promete tiempo de ejecución fuera de la confirmación de red.

## Frontera de firma

El preview utiliza datos públicos, UTXOs y scripts. Las llaves privadas solo se obtienen del servicio local de wallet dentro de la fase de confirmación. La transacción firmada se transmite directamente a Chronik. Ningún endpoint de Firma, Agora o documentación recibe seed, clave privada o material de firma.

## Errores esperados

- plugin Agora ausente;
- génesis o metadata FIRMA inconsistente;
- oferta gastada o cambiada;
- maker/covenant inválido o token falso;
- cantidad inferior al mínimo o granularidad no representable;
- remainder no-cero inferior al mínimo o cuyo valor queda bajo dust;
- liquidez FIRMA insuficiente;
- XEC insuficiente para precio, dust o comisión;
- FIRMA insuficiente en la dirección activa;
- bid o capacidad de redención no disponibles;
- fallo de red, indexación o broadcast.

## Prueba manual on-chain

No se ejecuta automáticamente con fondos reales. En una wallet de prueba respaldada:

1. abre `/dex?mode=firma` o configura `VITE_AGORA_CHRONIK_URL` con otro Chronik mainnet que tenga el plugin Agora;
2. comprueba que el Token ID visible coincide exactamente con la génesis;
3. publica desde una segunda wallet una oferta FIRMA canónica y confirma que aparece como `peer`; compra una cantidad pequeña y verifica preview, TXID y aumento de balance;
4. publica una venta pequeña, verifica el output `txid:1` y su aparición en Agora;
5. con capacidad suficiente del sweeper, prepara una redención de al menos `0.01 FIRMA`, compara bid/precio efectivo y confirma;
6. verifica en el explorer que las tres firmas y broadcasts fueron on-chain;
7. repite los smoke tests de RMZ, NFT, Mint Pass y WalletConnect.

## Diferencias con la documentación histórica

Los PDFs históricos describen el DEX completo como “oneshot por Offer ID” y proponen infraestructura propia futura. El `main` actual ya contiene ofertas parciales ALP para RMZ y `ecash-agora`; por eso Firma Alpha se implementa sobre esos covenants actuales. NFT y Mint Pass conservan el flujo oneshot existente. No se recuperó ni reutilizó código o commits de ejecuciones anteriores.
