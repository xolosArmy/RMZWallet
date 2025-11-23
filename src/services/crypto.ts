import CryptoJS from 'crypto-js'

// Cifrado DEMO: usa SHA256 directo como clave simétrica.
// Para producción se debe migrar a PBKDF2/scrypt con salt aleatorio e iteraciones altas.
export function encryptWithPassword(plainText: string, password: string): string {
  const key = CryptoJS.SHA256(password).toString()
  return CryptoJS.AES.encrypt(plainText, key).toString()
}

export function decryptWithPassword(cipherText: string, password: string): string {
  const key = CryptoJS.SHA256(password).toString()
  const bytes = CryptoJS.AES.decrypt(cipherText, key)
  const decrypted = bytes.toString(CryptoJS.enc.Utf8)

  if (!decrypted) {
    throw new Error('No se pudo descifrar la semilla. Password incorrecto o datos corruptos.')
  }

  return decrypted
}
