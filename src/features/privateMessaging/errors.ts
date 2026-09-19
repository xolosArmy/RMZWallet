export const TM_COMM_ERROR_CODES = Object.freeze({
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  INVALID_INPUT: 'INVALID_INPUT',
  CHALLENGE_EXPIRED: 'CHALLENGE_EXPIRED',
  CHALLENGE_CONSUMED: 'CHALLENGE_CONSUMED',
  CHALLENGE_ORIGIN_MISMATCH: 'CHALLENGE_ORIGIN_MISMATCH',
  SIGNATURE_INVALID: 'SIGNATURE_INVALID',
  ENROLLMENT_REQUIRED: 'ENROLLMENT_REQUIRED',
  ENROLLMENT_INVALID: 'ENROLLMENT_INVALID',
  ATTACHMENT_UNAVAILABLE: 'ATTACHMENT_UNAVAILABLE',
  FINANCIAL_CAPABILITY_DENIED: 'FINANCIAL_CAPABILITY_DENIED',
  MEMO_PUBLICATION_DENIED: 'MEMO_PUBLICATION_DENIED'
} as const)

export type TmCommErrorCode =
  (typeof TM_COMM_ERROR_CODES)[keyof typeof TM_COMM_ERROR_CODES]

export class TmCommError extends Error {
  readonly code: TmCommErrorCode
  readonly status: number
  readonly reasonCode: string

  constructor(
    code: TmCommErrorCode,
    status: number,
    message: string,
    reasonCode: string = code
  ) {
    super(message)
    this.name = 'TmCommError'
    this.code = code
    this.status = status
    this.reasonCode = reasonCode
  }
}

export const tmCommUnauthenticated = (reasonCode = 'SESSION_REQUIRED') =>
  new TmCommError(
    TM_COMM_ERROR_CODES.UNAUTHENTICATED,
    401,
    'Authentication is required.',
    reasonCode
  )

export const tmCommForbidden = (reasonCode: string) =>
  new TmCommError(
    TM_COMM_ERROR_CODES.FORBIDDEN,
    403,
    'Request is not authorized for this resource.',
    reasonCode
  )

export const tmCommInvalidInput = (reasonCode: string, message: string) =>
  new TmCommError(
    TM_COMM_ERROR_CODES.INVALID_INPUT,
    400,
    message,
    reasonCode
  )
