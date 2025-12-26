declare module 'crypto-js' {
  type WordArray = {
    toString: (encoder?: unknown) => string
  }

  const CryptoJS: {
    SHA256: (message: string) => WordArray
    AES: {
      encrypt: (message: string, key: string) => WordArray
      decrypt: (cipherText: string, key: string) => WordArray
    }
    enc: {
      Utf8: unknown
    }
  }

  export default CryptoJS
}
