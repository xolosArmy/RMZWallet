# Pruebas manuales NFTs (Tonalli)

Flujo recomendado:
1) Compra Mint Pass (Parent Token) en /dex?mode=mintpass.
2) Mint NFT child en /nfts (1 Mint Pass = 1 NFT).
3) Listar o enviar NFT desde /nfts o /dex.

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
- Verificar que aparece en el listado al cargar ofertas por tokenId.

4) Comprar NFT desde otra wallet
- Con otra wallet, cargar ofertas del tokenId.
- Comprar la oferta.
- Verificar el swap y que el NFT aparece en la wallet compradora.
