# Pruebas manuales NFTs (Tonalli)

Flujo recomendado:
1) Compra Mint Pass (Parent Token) con un Offer ID en /dex?mode=mintpass.
2) Mint NFT child en /nfts (1 Mint Pass = 1 NFT).
3) Crear y compartir ofertas por Offer ID desde /dex.

1) Mint NFT child con imagen
- Abrir /nfts, ir a “Mintear NFT”.
- Subir imagen, completar nombre y descripcion.
- Confirmar que se sube a Pinata y aparece en “Mis NFTs”.

2) Transferencia de NFT
- En “Mis NFTs”, seleccionar “Enviar”.
- Enviar a otra address eCash.
- Verificar que desaparece del remitente y aparece en la wallet destino.

3) Listar NFT en DEX (sell)
- Ir a /dex y abrir “NFT Market”.
- Seleccionar NFT propio, definir precio en XEC, publicar oferta.
- Copiar el Offer ID y compartirlo con el comprador.

4) Comprar NFT desde otra wallet
- Con otra wallet, abrir “NFT Market” y pegar el Offer ID.
- Cargar la oferta, revisar el preview y comprar.
- Verificar el swap y que el NFT aparece en la wallet compradora.
