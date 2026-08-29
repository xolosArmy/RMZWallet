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
