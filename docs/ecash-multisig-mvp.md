# MVP multifirma eCash P2SH

Esta guía documenta el flujo manual para usar bóvedas multifirma eCash P2SH m-de-n en Tonalli Wallet.

## Advertencia

La multifirma eCash P2SH es funcionalidad experimental. Usa primero montos pequeños y verifica cada campo antes de firmar o transmitir.

Reglas del MVP:

- 1 dispositivo = 1 firmante.
- No importes varias semillas en el mismo dispositivo.
- No uses RMZ/ALP todavía.
- No uses UTXOs con tokens.
- Usa solo XEC puro.
- No cambies manualmente `redeemScriptHex`, `scriptHashHex`, `address`, inputs ni outputs del `partialTxHex`.

## Qué es una bóveda eCash P2SH m-de-n

Una bóveda eCash P2SH m-de-n es una dirección eCash que bloquea XEC con un `redeemScript` multifirma. La bóveda tiene `n` public keys autorizadas y requiere al menos `m` firmas válidas para gastar cada input.

Ejemplo: una bóveda 2-de-3 tiene tres firmantes posibles, pero cualquier gasto necesita dos firmas válidas en cada input.

La bóveda guarda datos públicos:

- `m` y `n`.
- Public keys de firmantes.
- `redeemScriptHex`.
- `scriptHashHex`.
- Dirección P2SH para recibir XEC.

La bóveda exportada no debe contener private keys ni seed phrases.

## Preparar firmantes

Cada firmante debe usar una wallet distinta en un dispositivo distinto.

Para copiar la public key de un firmante:

1. Desbloquea Tonalli Wallet en el dispositivo del firmante.
2. Abre `/multisig/create`.
3. Usa `Agregar mi public key`.
4. Copia la public key hex que aparece en el campo de public keys.
5. Comparte solo esa public key con quien creará la bóveda.

No compartas seed phrase ni private key.

## Crear bóveda

En el dispositivo que actuará como firmante inicial:

1. Abre `/multisig/create`.
2. Escribe una etiqueta clara, por ejemplo `Tesoreria 2-de-3`.
3. Define `Firmas requeridas`, por ejemplo `2`.
4. Pega una public key hex por línea.
5. Incluye la public key de la wallet actual.
6. Revisa que el número de public keys corresponda al `n` esperado.
7. Selecciona `Crear bóveda`.

Al crear la bóveda, Tonalli ordena las public keys y deriva:

- `redeemScriptHex`.
- `scriptHashHex`.
- Dirección P2SH eCash.

## Exportar e importar bóveda

Para exportar:

1. Abre `/multisig`.
2. En la bóveda, selecciona `Exportar JSON`.
3. Copia el JSON público.

Para importar en otro dispositivo firmante:

1. Desbloquea la wallet del firmante.
2. Abre `/multisig`.
3. Pega el JSON en `JSON público de bóveda`.
4. Selecciona `Importar bóveda`.
5. Verifica que la dirección P2SH importada sea exactamente la misma que la bóveda original.

La importación debe fallar si la wallet actual no es firmante o si el `redeemScript`, `scriptHash` o `address` fueron manipulados.

## Fondear la direccion P2SH

No uses `/send-xec` para fondear bovedas P2SH. El flujo actual de `/send-xec` usa `minimal-xec-wallet` y puede rechazar destinos P2SH aunque la direccion de la boveda sea valida.

Usa el boton `Fondear boveda` dentro de `/multisig`:

1. Abre `/multisig`.
2. Busca la boveda que quieres fondear.
3. En `Fondear boveda`, escribe una cantidad pequena de XEC puro.
4. Revisa el preview: direccion P2SH, monto y fee Tonalli si aplica.
5. Selecciona `Fondear boveda`.
6. Copia el `txid` devuelto.
7. Espera a que Chronik detecte el UTXO.
8. Confirma en `/multisig` que el balance de XEC puro aparece en la boveda.

Este fondeo usa la wallet actual single-sig como fuente de fondos y construye la transaccion con `ecash-lib` directamente para enviar a la direccion P2SH de la boveda.

No envies RMZ, ALP, NFTs ni otros tokens a la boveda para este MVP.

## Crear proposal

En un dispositivo firmante que tenga la bóveda:

1. Abre `/multisig`.
2. Selecciona `Crear propuesta`.
3. Pega el destino `ecash:...`.
4. Escribe el monto XEC.
5. Marca `Incluir fee Tonalli` solo si ese pago debe incluir la fee de servicio.
6. Selecciona `Crear partialTxHex`.
7. Copia el `partialTxHex` generado.

La propuesta inicial queda firmada por el dispositivo que la creó. Para una bóveda 2-de-3 todavía necesita una segunda firma válida antes de transmitir.

## Propuestas con memo L1 OP_RETURN

Las propuestas multifirma pueden incluir un memo L1 `OP_RETURN` opcional para coordinación auditable en cadena. El memo es XEC-only y no habilita RMZ/ALP, NFTs ni token UTXOs.

Reglas del memo:

- El memo es opcional; si el campo queda vacío no se agrega `OP_RETURN`.
- El límite es 80 bytes UTF-8.
- Todos los firmantes deben inspeccionar el memo decodificado antes de firmar.
- No firmes scripts desconocidos ni outputs que no esperabas.
- Para THORChain ADDLP, el memo y el orden de outputs deben revisarse cuidadosamente antes de firmar. El soporte genérico de memo no reemplaza una revisión específica de compatibilidad ADDLP.

Uso Governance-Bridge: Tonalli Governance multisig puede coordinar más adelante ADDLP con THORChain / Bitcoin ABC desde una dirección XEC durable y recuperable.

## Qué revisar antes de firmar

Antes de agregar tu firma:

1. Abre `/multisig/<vaultId>/sign`.
2. Pega el `partialTxHex`.
3. Selecciona `Ver resumen`.
4. Revisa:
   - Destino.
   - Monto.
   - Cambio a la bóveda.
   - Fee Tonalli, si existe.
   - Fee de red implícita por diferencia entre inputs y outputs.
   - Firmas válidas por input.
   - Warnings.

No firmes si:

- El destino no coincide con lo acordado.
- El monto no coincide.
- El cambio no regresa a la bóveda.
- Aparece un output desconocido que no esperabas.
- La fee Tonalli aparece cuando no debe, o falta cuando sí debe.
- Hay warnings.
- Algún input no pertenece a la bóveda esperada.

## Cofirmar partialTxHex

En el dispositivo del segundo firmante:

1. Importa la bóveda si todavía no está importada.
2. Abre `/multisig`.
3. Selecciona `Firmar / transmitir`.
4. Pega el `partialTxHex`.
5. Selecciona `Ver resumen`.
6. Revisa todos los campos del resumen seguro.
7. Si todo coincide, selecciona `Agregar mi firma`.
8. Copia el `partialTxHex` actualizado.

Para una bóveda 2-de-3, el `partialTxHex` actualizado debe mostrar al menos 2 firmas válidas por input.

## Transmitir

La transmisión puede hacerla cualquier dispositivo que tenga la bóveda importada y el `partialTxHex` completo.

1. Abre `/multisig`.
2. Selecciona `Firmar / transmitir`.
3. Pega el `partialTxHex` actualizado.
4. Selecciona `Ver resumen`.
5. Confirma que todos los inputs tienen al menos `m` firmas válidas.
6. Selecciona `Transmitir`.
7. Copia el `txid` devuelto.

## Verificar txid

Después del broadcast:

1. Copia el `txid`.
2. Ábrelo en un explorer eCash confiable.
3. Verifica:
   - El destino.
   - El monto.
   - El cambio.
   - La fee de red.
   - La confirmación o presencia en mempool.

## Prueba recomendada 2-de-3

Usa montos pequeños.

1. Crea wallet A en el dispositivo A.
2. Crea wallet B en el dispositivo B.
3. Crea wallet C en el dispositivo C.
4. En A, B y C, abre `/multisig/create`, usa `Agregar mi public key` y copia la public key de cada wallet.
5. En A, crea una bóveda con `m = 2` y las public keys de A, B y C.
6. En A, abre `/multisig` y exporta el JSON público de la bóveda.
7. En B, importa el JSON público de la bóveda.
8. Fondea la direccion P2SH con poco XEC puro usando el boton `Fondear boveda` dentro de `/multisig`.
9. En A, crea una propuesta hacia una dirección de prueba.
10. Copia el `partialTxHex` de A.
11. En B, pega el `partialTxHex`, selecciona `Ver resumen` y revisa destino, monto, cambio, fee Tonalli, fee de red, firmas por input y warnings.
12. En B, selecciona `Agregar mi firma`.
13. En B, transmite el `partialTxHex` completo.
14. Copia el `txid`.
15. Verifica el `txid` en un explorer eCash.

Opcional: importa la bóveda en C y confirma que C también puede revisar el resumen o actuar como segundo firmante en otra prueba.

## Cosas que bloquean broadcast

El broadcast debe bloquearse si ocurre cualquiera de estas condiciones:

- Menos de `m` firmas válidas en cualquier input.
- El UTXO no pertenece a la bóveda.
- El UTXO ya está gastado o no está disponible.
- El UTXO tiene token.
- Hay una firma inválida.
- Hay una firma duplicada.
- Alguna firma usa un sighash distinto de `ALL_BIP143`.
- El `redeemScript` fue manipulado.
- El `address` o `scriptHash` no coincide con el `redeemScript`.

Si el broadcast falla, vuelve a cargar el resumen, confirma que los UTXOs siguen disponibles y genera una nueva propuesta si el estado de la bóveda cambió.

Si una propuesta completa falla con min relay fee not met, descarta el partialTxHex y crea una nueva propuesta. No edites manualmente el hex porque invalida las firmas.

## Registro de pruebas

- Fecha: 2026-06-24
- Red: eCash mainnet
- Configuración: 2-de-3 P2SH
- Dirección de bóveda: ecash:ppev5u3xnqqk4nxsrxxq6xn94ck2yqnvpg2wamux7f
- Fondeo TXID: 72c34c5c93dc44032f8f138928e02fb16b3669b8b4a698660ad2e50e592304ff
- Primera tx multifirma TXID: 3dec057346e0e31e82e40ef5802ef179bd02441e6eb3ccc94d3f6fe0f5319329
- Resultado: exitosa
- Notas: primera transacción eCash P2SH 2-de-3 creada, cofirmada y transmitida desde Tonalli Wallet.
