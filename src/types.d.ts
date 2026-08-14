declare module 'crypto-js' {
  type WordArray = {
    toString: (encoder?: unknown) => string
  }

  const CryptoJS: {
    SHA256: (message: string) => WordArray
    HmacSHA512: (message: WordArray, key: WordArray) => WordArray
    AES: {
      encrypt: (message: string, key: string) => WordArray
      decrypt: (cipherText: string, key: string) => WordArray
    }
    enc: {
      Hex: {
        parse: (value: string) => WordArray
      }
      Utf8: unknown
    }
  }

  export default CryptoJS
}
