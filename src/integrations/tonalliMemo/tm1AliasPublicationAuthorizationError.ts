export type Tm1AliasPublicationAuthorizationErrorCode =
  | 'INVALID_ALIAS_AUTHORIZATION_INPUT'
  | 'ALIAS_UNCONFIRMED'
  | 'ALIAS_OWNER_MISMATCH'
  | 'ALIAS_PROOF_UNVERIFIABLE'
  | 'ALIAS_PROOF_EXPIRED'
  | 'ALIAS_PROOF_REPLAYED'
  | 'ALIAS_PROOF_STALE'
  | 'ALIAS_EVIDENCE_UNTRUSTED'

export class Tm1AliasPublicationAuthorizationError extends Error {
  readonly code: Tm1AliasPublicationAuthorizationErrorCode

  constructor(code: Tm1AliasPublicationAuthorizationErrorCode) {
    super(code)
    this.name = 'Tm1AliasPublicationAuthorizationError'
    this.code = code
  }
}
