export type AgentWalletHandoffCodecErrorCode =
  | 'INVALID_INPUT_TYPE'
  | 'INVALID_VALUE'
  | 'CONTENT_TOO_LARGE'
  | 'BAD_MAGIC'
  | 'UNSUPPORTED_VERSION'
  | 'TRUNCATED'
  | 'TRAILING_BYTES'
  | 'INVALID_LENGTH'
  | 'INVALID_PRESENCE_TAG'
  | 'INVALID_ASCII'
  | 'INVALID_UTF8'
  | 'INVALID_INTEGER'
  | 'NON_CANONICAL_DECIMAL'
  | 'DECODED_VALUE_INVALID'
  | 'NON_CANONICAL_CONTENT'

const ERROR_MESSAGES = Object.freeze({
  INVALID_INPUT_TYPE: 'Expected a supported input value',
  INVALID_VALUE: 'Value does not satisfy the canonical Core contract',
  CONTENT_TOO_LARGE: 'Effective content exceeds the permitted size',
  BAD_MAGIC: 'Effective content has an invalid magic prefix',
  UNSUPPORTED_VERSION: 'Effective content uses an unsupported format version',
  TRUNCATED: 'Effective content is truncated',
  TRAILING_BYTES: 'Effective content contains trailing bytes',
  INVALID_LENGTH: 'Effective content contains an invalid length',
  INVALID_PRESENCE_TAG: 'Effective content contains an invalid presence tag',
  INVALID_ASCII: 'Effective content contains invalid ASCII',
  INVALID_UTF8: 'Effective content contains invalid UTF-8',
  INVALID_INTEGER: 'Effective content contains an invalid integer',
  NON_CANONICAL_DECIMAL: 'Effective content contains a noncanonical decimal',
  DECODED_VALUE_INVALID: 'Decoded content does not satisfy the canonical Core contract',
  NON_CANONICAL_CONTENT: 'Effective content is not canonically encoded'
}) satisfies Readonly<Record<AgentWalletHandoffCodecErrorCode, string>>

export class AgentWalletHandoffCodecError extends Error {
  readonly code: AgentWalletHandoffCodecErrorCode

  constructor(code: AgentWalletHandoffCodecErrorCode, cause?: unknown) {
    super(ERROR_MESSAGES[code], cause === undefined ? undefined : { cause })
    this.name = 'AgentWalletHandoffCodecError'
    this.code = code
  }
}
