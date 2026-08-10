# DEX Agora

El DEX de Tonalli combina ofertas parciales ALP y ofertas oneshot. Firma Alpha usa descubrimiento automático del orderbook Agora; los flujos heredados RMZ, NFT y Mint Pass conservan sus mecanismos actuales y pueden requerir un Offer ID (`txid:vout`).

## Firma Alpha

La pestaña Firma Alpha ofrece mercado `XEC ↔ FIRMA`, saldo verificado, compra, venta y redención on-chain con preview obligatorio y firma local. Consulta identidad, seguridad, infraestructura y prueba manual en [firma-alpha.md](firma-alpha.md).

## Vender (crear oferta)
1) Abre `/dex`.
2) Selecciona la tab correspondiente (Firma Alpha, RMZ, NFT Market o Mint Pass).
3) Define precio y publica la oferta.
4) Copia el Offer ID y compártelo con el comprador.

## Comprar (aceptar oferta)
1) Pega el Offer ID en la sección de compra.
2) Carga la oferta para ver el preview.
3) Confirma y firma la compra.

## Mint Pass
- Para comprar Mint Pass necesitas que alguien te comparta un Offer ID.
- Cada Mint Pass comprado se puede usar para mintear un NFT child.
