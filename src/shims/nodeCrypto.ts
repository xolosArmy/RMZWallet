import CryptoJS from 'crypto-js'

type HashEncoding = 'utf8'
type DigestEncoding = 'hex'

class Sha256Hash {
  private value = ''

  update(value: string, encoding: HashEncoding = 'utf8') {
    if (encoding !== 'utf8') throw new TypeError('Only utf8 hashing is supported')
    this.value += value
    return this
  }

  digest(encoding: DigestEncoding) {
    if (encoding !== 'hex') throw new TypeError('Only hex digests are supported')
    return CryptoJS.SHA256(this.value).toString()
  }
}

export const createHash = (algorithm: string) => {
  if (algorithm !== 'sha256') throw new TypeError('Only SHA-256 is supported')
  return new Sha256Hash()
}
