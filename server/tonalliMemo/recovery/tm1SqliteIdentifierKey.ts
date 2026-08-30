const TM1_SQLITE_IDENTIFIER_KEY_PREFIX = 'u16:'

/**
 * Encodes a JavaScript string as an injective SQLite-safe physical key.
 *
 * JavaScript strings are UTF-16 code-unit sequences, including potentially
 * unpaired surrogates. Encoding each code unit independently avoids Unicode
 * normalization, UTF-8 replacement and any dependency on well-formedness.
 */
export function encodeTm1SqliteIdentifierKey(value: string): string {
  let key = TM1_SQLITE_IDENTIFIER_KEY_PREFIX
  for (let index = 0; index < value.length; index += 1) {
    key += value.charCodeAt(index).toString(16).padStart(4, '0')
  }
  return key
}

/** Decodes only the canonical physical form emitted by the encoder above. */
export function decodeTm1SqliteIdentifierKey(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith(TM1_SQLITE_IDENTIFIER_KEY_PREFIX) ||
    (value.length - TM1_SQLITE_IDENTIFIER_KEY_PREFIX.length) % 4 !== 0 ||
    !/^[0-9a-f]*$/.test(value.slice(TM1_SQLITE_IDENTIFIER_KEY_PREFIX.length))
  ) throw new TypeError('INVALID_TM1_SQLITE_IDENTIFIER_KEY')
  let result = ''
  for (
    let index = TM1_SQLITE_IDENTIFIER_KEY_PREFIX.length;
    index < value.length;
    index += 4
  ) {
    result += String.fromCharCode(Number.parseInt(value.slice(index, index + 4), 16))
  }
  if (encodeTm1SqliteIdentifierKey(result) !== value) {
    throw new TypeError('INVALID_TM1_SQLITE_IDENTIFIER_KEY')
  }
  return result
}
