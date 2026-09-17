import {
  createTmCommAuthChallengeView
} from '../../src/features/privateMessaging/authChallenge'
import {
  TM_COMM_MAX_MESSAGE_BODY_CHARS
} from '../../src/features/privateMessaging/contracts'
import {
  TmCommError,
  TM_COMM_ERROR_CODES,
  tmCommForbidden,
  tmCommInvalidInput,
  tmCommUnauthenticated
} from '../../src/features/privateMessaging/errors'
import type {
  TmCommConversation,
  TmCommMessage,
  TmCommMessageReceipt,
  TmCommPrincipal,
  TmCommReceiptState,
  TmCommReservationBinding
} from '../../src/features/privateMessaging/types'
import type { TmCommRuntimeConfig } from './tmCommConfig'
import { createTmCommId, createTmCommSecretHex } from './tmCommIds'
import {
  createAuditEvent,
  type TmCommStore
} from './tmCommStore'
import {
  normalizeWalletAddress,
  sha256Hex,
  verifyTmCommWalletSignature
} from './tmCommVerify'

export type TmCommAuthenticatedPrincipal = TmCommPrincipal

const CLIENT_MESSAGE_ID = /^[A-Za-z0-9._:-]{8,128}$/

export class TmCommService {
  private readonly store: TmCommStore
  private readonly config: TmCommRuntimeConfig
  private readonly now: () => number

  constructor(
    store: TmCommStore,
    config: TmCommRuntimeConfig,
    now: () => number = () => Date.now()
  ) {
    this.store = store
    this.config = config
    this.now = now
  }

  createChallenge(requestOrigin: string | null): {
    challengeId: string
    nonce: string
    expiresAt: number
    audience: string
    origin: string
    sessionContext: string
    canonicalMessage: string
  } {
    const origin = this.requireExpectedOrigin(requestOrigin)
    const now = this.now()
    const challengeId = createTmCommId('challenge')
    const nonce = createTmCommSecretHex(24)
    const expiresAt = now + this.config.challengeTtlMs
    const view = createTmCommAuthChallengeView({
      challengeId,
      nonce,
      expiresAt,
      audience: this.config.expectedOrigin,
      origin,
      sessionContext: this.config.sessionContext
    })
    this.store.insertChallenge({
      id: challengeId,
      nonceHash: sha256Hex(nonce),
      audience: this.config.expectedOrigin,
      origin,
      sessionContext: this.config.sessionContext,
      canonicalMessage: view.canonicalMessage,
      expiresAt,
      consumedAt: null,
      createdAt: now
    })
    this.audit({
      at: now,
      actorPrincipalId: null,
      action: 'challenge.create',
      resourceType: 'challenge',
      resourceId: challengeId,
      outcome: 'allow',
      reasonCode: 'CHALLENGE_ISSUED'
    })
    return {
      challengeId,
      nonce,
      expiresAt,
      audience: this.config.expectedOrigin,
      origin,
      sessionContext: this.config.sessionContext,
      canonicalMessage: view.canonicalMessage
    }
  }

  createSession(input: {
    challengeId: string
    address: string
    publicKeyHex: string
    signature: string
    requestOrigin: string | null
  }): { token: string; principal: TmCommPrincipal; expiresAt: number } {
    const origin = this.requireExpectedOrigin(input.requestOrigin)
    const now = this.now()
    const challenge = this.store.findChallengeById(input.challengeId)
    if (challenge === null) {
      this.audit({
        at: now,
        actorPrincipalId: null,
        action: 'session.create',
        resourceType: 'challenge',
        resourceId: input.challengeId,
        outcome: 'deny',
        reasonCode: 'CHALLENGE_UNKNOWN'
      })
      throw tmCommUnauthenticated('CHALLENGE_UNKNOWN')
    }
    if (challenge.consumedAt !== null) {
      this.audit({
        at: now,
        actorPrincipalId: null,
        action: 'session.create',
        resourceType: 'challenge',
        resourceId: challenge.id,
        outcome: 'deny',
        reasonCode: 'CHALLENGE_CONSUMED'
      })
      throw new TmCommError(
        TM_COMM_ERROR_CODES.CHALLENGE_CONSUMED,
        401,
        'Challenge already used.',
        'CHALLENGE_CONSUMED'
      )
    }
    if (now >= challenge.expiresAt) {
      this.audit({
        at: now,
        actorPrincipalId: null,
        action: 'session.create',
        resourceType: 'challenge',
        resourceId: challenge.id,
        outcome: 'deny',
        reasonCode: 'CHALLENGE_EXPIRED'
      })
      throw new TmCommError(
        TM_COMM_ERROR_CODES.CHALLENGE_EXPIRED,
        401,
        'Challenge expired.',
        'CHALLENGE_EXPIRED'
      )
    }
    if (challenge.origin !== origin || challenge.audience !== this.config.expectedOrigin) {
      this.audit({
        at: now,
        actorPrincipalId: null,
        action: 'session.create',
        resourceType: 'challenge',
        resourceId: challenge.id,
        outcome: 'deny',
        reasonCode: 'CHALLENGE_ORIGIN_MISMATCH'
      })
      throw new TmCommError(
        TM_COMM_ERROR_CODES.CHALLENGE_ORIGIN_MISMATCH,
        401,
        'Challenge origin does not match the expected audience.',
        'CHALLENGE_ORIGIN_MISMATCH'
      )
    }
    if (challenge.sessionContext !== this.config.sessionContext) {
      throw tmCommUnauthenticated('SESSION_CONTEXT_MISMATCH')
    }

    let address: string
    try {
      address = normalizeWalletAddress(input.address)
    } catch {
      throw tmCommUnauthenticated('ADDRESS_INVALID')
    }

    const signatureValid = verifyTmCommWalletSignature({
      canonicalMessage: challenge.canonicalMessage,
      signature: input.signature,
      address,
      publicKeyHex: input.publicKeyHex.trim().toLowerCase()
    })
    if (!signatureValid) {
      this.audit({
        at: now,
        actorPrincipalId: null,
        action: 'session.create',
        resourceType: 'challenge',
        resourceId: challenge.id,
        outcome: 'deny',
        reasonCode: 'SIGNATURE_INVALID'
      })
      throw new TmCommError(
        TM_COMM_ERROR_CODES.SIGNATURE_INVALID,
        401,
        'Wallet signature is invalid.',
        'SIGNATURE_INVALID'
      )
    }

    return this.store.withTransaction(() => {
      if (!this.store.consumeChallenge(challenge.id, now)) {
        throw new TmCommError(
          TM_COMM_ERROR_CODES.CHALLENGE_CONSUMED,
          401,
          'Challenge already used.',
          'CHALLENGE_CONSUMED'
        )
      }
      const publicKeyHex = input.publicKeyHex.trim().toLowerCase()
      let principal = this.store.findPrincipalByAddress(address)
      if (principal === null) {
        principal = this.store.insertPrincipal({
          id: createTmCommId('principal'),
          kind: 'customer',
          walletAddress: address,
          publicKeyHex,
          createdAt: now
        })
      } else if (principal.publicKeyHex !== publicKeyHex) {
        throw tmCommUnauthenticated('PUBLIC_KEY_MISMATCH')
      }

      const token = createTmCommSecretHex(32)
      const expiresAt = now + this.config.sessionTtlMs
      this.store.insertSession({
        id: createTmCommId('session'),
        tokenHash: sha256Hex(token),
        principalId: principal.id,
        challengeId: challenge.id,
        audience: this.config.expectedOrigin,
        expiresAt,
        createdAt: now,
        revokedAt: null
      })
      this.audit({
        at: now,
        actorPrincipalId: principal.id,
        action: 'session.create',
        resourceType: 'session',
        resourceId: principal.id,
        outcome: 'allow',
        reasonCode: 'SESSION_CREATED'
      })
      return { token, principal, expiresAt }
    })
  }

  authenticate(token: string | null): TmCommPrincipal {
    if (token === null || token.length === 0) {
      throw tmCommUnauthenticated('SESSION_REQUIRED')
    }
    const session = this.store.findSessionByTokenHash(sha256Hex(token))
    const now = this.now()
    if (
      session === null ||
      session.revokedAt !== null ||
      now >= session.expiresAt ||
      session.audience !== this.config.expectedOrigin
    ) {
      this.audit({
        at: now,
        actorPrincipalId: null,
        action: 'session.resolve',
        resourceType: 'session',
        resourceId: null,
        outcome: 'deny',
        reasonCode: 'SESSION_INVALID'
      })
      throw tmCommUnauthenticated('SESSION_INVALID')
    }
    const principal = this.store.findPrincipalById(session.principalId)
    if (principal === null) {
      throw tmCommUnauthenticated('PRINCIPAL_MISSING')
    }
    return principal
  }

  getMe(principal: TmCommPrincipal) {
    return {
      principal: {
        id: principal.id,
        kind: principal.kind,
        walletAddress: principal.walletAddress
      },
      bindings: this.store.listBindingsForPrincipal(principal.id)
    }
  }

  bindReservation(
    principal: TmCommPrincipal,
    enrollmentToken: string,
    claimedReservationId: string | undefined
  ): { binding: TmCommReservationBinding; conversation: TmCommConversation } {
    const now = this.now()
    const tokenHash = sha256Hex(enrollmentToken.trim())
    const invitation = this.store.findEnrollmentByTokenHash(tokenHash)
    if (invitation === null) {
      this.deny(principal, 'binding.create', 'enrollment', null, 'ENROLLMENT_UNKNOWN')
      throw new TmCommError(
        TM_COMM_ERROR_CODES.ENROLLMENT_INVALID,
        403,
        'Enrollment token is invalid.',
        'ENROLLMENT_UNKNOWN'
      )
    }
    if (invitation.consumedAt !== null) {
      this.deny(principal, 'binding.create', 'enrollment', invitation.id, 'ENROLLMENT_CONSUMED')
      throw new TmCommError(
        TM_COMM_ERROR_CODES.ENROLLMENT_INVALID,
        403,
        'Enrollment token is invalid.',
        'ENROLLMENT_CONSUMED'
      )
    }
    if (now >= invitation.expiresAt) {
      this.deny(principal, 'binding.create', 'enrollment', invitation.id, 'ENROLLMENT_EXPIRED')
      throw new TmCommError(
        TM_COMM_ERROR_CODES.ENROLLMENT_INVALID,
        403,
        'Enrollment token is invalid.',
        'ENROLLMENT_EXPIRED'
      )
    }
    if (
      claimedReservationId !== undefined &&
      claimedReservationId !== invitation.reservationId
    ) {
      this.deny(
        principal,
        'binding.create',
        'reservation',
        claimedReservationId,
        'RESERVATION_CLAIM_MISMATCH'
      )
      throw tmCommForbidden('RESERVATION_CLAIM_MISMATCH')
    }

    return this.store.withTransaction(() => {
      if (!this.store.consumeEnrollment(invitation.id, principal.id, now)) {
        throw new TmCommError(
          TM_COMM_ERROR_CODES.ENROLLMENT_INVALID,
          403,
          'Enrollment token is invalid.',
          'ENROLLMENT_CONSUMED'
        )
      }
      const existing = this.store.findBinding(principal.id, invitation.reservationId)
      if (existing !== null) {
        throw new TmCommError(
          TM_COMM_ERROR_CODES.CONFLICT,
          409,
          'Reservation is already bound.',
          'BINDING_EXISTS'
        )
      }
      const binding: TmCommReservationBinding = {
        id: createTmCommId('binding'),
        principalId: principal.id,
        reservationId: invitation.reservationId,
        enrollmentTokenId: invitation.id,
        boundAt: now,
        createdBy: 'xolos-ramirez-operator'
      }
      this.store.insertBinding(binding)
      const conversation = this.ensureConversation(invitation.reservationId, principal, now)
      this.audit({
        at: now,
        actorPrincipalId: principal.id,
        action: 'binding.create',
        resourceType: 'reservation',
        resourceId: invitation.reservationId,
        outcome: 'allow',
        reasonCode: 'BINDING_CREATED'
      })
      return { binding, conversation }
    })
  }

  listConversations(principal: TmCommPrincipal): TmCommConversation[] {
    return this.store.listConversationsForPrincipal(principal.id)
  }

  getConversation(principal: TmCommPrincipal, conversationId: string): TmCommConversation {
    return this.requireConversationAccess(principal, conversationId, 'conversation.read')
  }

  listMessages(principal: TmCommPrincipal, conversationId: string): TmCommMessage[] {
    this.requireConversationAccess(principal, conversationId, 'message.list')
    return this.store.listMessages(conversationId)
  }

  sendMessage(
    principal: TmCommPrincipal,
    conversationId: string,
    input: {
      clientMessageId: string
      body: string
      replyToId?: string | null
      claimedSenderPrincipalId?: string
      claimedConversationId?: string
      claimedReservationId?: string
      claimedCustomerId?: string
      claimedWalletAddress?: string
    }
  ): TmCommMessage {
    if (
      input.claimedSenderPrincipalId !== undefined &&
      input.claimedSenderPrincipalId !== principal.id
    ) {
      this.deny(principal, 'message.send', 'principal', input.claimedSenderPrincipalId, 'SENDER_IMPERSONATION')
      throw tmCommForbidden('SENDER_IMPERSONATION')
    }
    if (
      input.claimedConversationId !== undefined &&
      input.claimedConversationId !== conversationId
    ) {
      this.deny(principal, 'message.send', 'conversation', input.claimedConversationId, 'CONVERSATION_CLAIM_MISMATCH')
      throw tmCommForbidden('CONVERSATION_CLAIM_MISMATCH')
    }
    if (input.claimedCustomerId !== undefined && input.claimedCustomerId !== principal.id) {
      this.deny(principal, 'message.send', 'principal', input.claimedCustomerId, 'CUSTOMER_CLAIM_MISMATCH')
      throw tmCommForbidden('CUSTOMER_CLAIM_MISMATCH')
    }
    if (
      input.claimedWalletAddress !== undefined &&
      input.claimedWalletAddress !== principal.walletAddress
    ) {
      this.deny(principal, 'message.send', 'principal', null, 'WALLET_CLAIM_MISMATCH')
      throw tmCommForbidden('WALLET_CLAIM_MISMATCH')
    }

    const conversation = this.requireConversationAccess(principal, conversationId, 'message.send')
    if (
      input.claimedReservationId !== undefined &&
      input.claimedReservationId !== conversation.reservationId
    ) {
      this.deny(principal, 'message.send', 'reservation', input.claimedReservationId, 'RESERVATION_CLAIM_MISMATCH')
      throw tmCommForbidden('RESERVATION_CLAIM_MISMATCH')
    }

    if (!CLIENT_MESSAGE_ID.test(input.clientMessageId)) {
      throw tmCommInvalidInput('CLIENT_MESSAGE_ID_INVALID', 'clientMessageId is invalid.')
    }
    const body = input.body.trim()
    if (body.length === 0 || body.length > TM_COMM_MAX_MESSAGE_BODY_CHARS) {
      throw tmCommInvalidInput('MESSAGE_BODY_INVALID', 'Message body is empty or too long.')
    }

    const existing = this.store.findMessageByClientId(conversationId, input.clientMessageId)
    if (existing !== null) {
      if (existing.senderPrincipalId !== principal.id || existing.body !== body) {
        throw new TmCommError(
          TM_COMM_ERROR_CODES.CONFLICT,
          409,
          'clientMessageId already exists with different content.',
          'IDEMPOTENCY_CONFLICT'
        )
      }
      return existing
    }

    if (input.replyToId) {
      const replyTo = this.store.findMessageById(input.replyToId)
      if (replyTo === null || replyTo.conversationId !== conversationId) {
        throw tmCommInvalidInput('REPLY_TARGET_INVALID', 'replyToId is not in this conversation.')
      }
    }

    const now = this.now()
    const message: TmCommMessage = {
      id: createTmCommId('message'),
      clientMessageId: input.clientMessageId,
      conversationId,
      senderPrincipalId: principal.id,
      senderKind: principal.kind,
      body,
      serverCreatedAt: now,
      replyToId: input.replyToId ?? null,
      status: 'accepted'
    }
    this.store.insertMessage(message)
    this.audit({
      at: now,
      actorPrincipalId: principal.id,
      action: 'message.send',
      resourceType: 'message',
      resourceId: message.id,
      outcome: 'allow',
      reasonCode: 'MESSAGE_ACCEPTED'
    })
    return this.store.findMessageById(message.id) ?? message
  }

  listReceipts(principal: TmCommPrincipal, messageId: string): TmCommMessageReceipt[] {
    const message = this.requireMessageAccess(principal, messageId, 'receipt.list')
    return this.store.listReceipts(message.id)
  }

  upsertReceipt(
    principal: TmCommPrincipal,
    messageId: string,
    state: TmCommReceiptState
  ): TmCommMessageReceipt {
    this.requireMessageAccess(principal, messageId, 'receipt.upsert')
    const receipt = this.store.upsertReceipt({
      id: createTmCommId('receipt'),
      messageId,
      principalId: principal.id,
      state,
      recordedAt: this.now()
    })
    this.audit({
      at: this.now(),
      actorPrincipalId: principal.id,
      action: 'receipt.upsert',
      resourceType: 'receipt',
      resourceId: receipt.id,
      outcome: 'allow',
      reasonCode: 'RECEIPT_RECORDED'
    })
    return receipt
  }

  denyAttachment(principal: TmCommPrincipal, attachmentId: string): never {
    this.deny(principal, 'attachment.read', 'attachment', attachmentId, 'ATTACHMENT_UNAVAILABLE')
    throw new TmCommError(
      TM_COMM_ERROR_CODES.ATTACHMENT_UNAVAILABLE,
      403,
      'Attachments are not available.',
      'ATTACHMENT_UNAVAILABLE'
    )
  }

  listDeniedAudits() {
    return this.store.listAuditEvents().filter((event) => event.outcome === 'deny')
  }

  private requireExpectedOrigin(requestOrigin: string | null): string {
    if (requestOrigin === null || requestOrigin !== this.config.expectedOrigin) {
      throw new TmCommError(
        TM_COMM_ERROR_CODES.CHALLENGE_ORIGIN_MISMATCH,
        401,
        'Request origin does not match the TM-COMM audience.',
        'ORIGIN_MISMATCH'
      )
    }
    return requestOrigin
  }

  private requireConversationAccess(
    principal: TmCommPrincipal,
    conversationId: string,
    action: string
  ): TmCommConversation {
    const conversation = this.store.findConversationById(conversationId)
    const allowed = conversation !== null &&
      this.store.isConversationParticipant(conversation.id, principal.id)
    if (!allowed) {
      this.deny(principal, action, 'conversation', conversationId, 'CONVERSATION_FORBIDDEN')
      throw tmCommForbidden('CONVERSATION_FORBIDDEN')
    }
    this.audit({
      at: this.now(),
      actorPrincipalId: principal.id,
      action,
      resourceType: 'conversation',
      resourceId: conversationId,
      outcome: 'allow',
      reasonCode: 'CONVERSATION_AUTHORIZED'
    })
    return conversation
  }

  private requireMessageAccess(
    principal: TmCommPrincipal,
    messageId: string,
    action: string
  ): TmCommMessage {
    const message = this.store.findMessageById(messageId)
    if (message === null) {
      this.deny(principal, action, 'message', messageId, 'MESSAGE_FORBIDDEN')
      throw tmCommForbidden('MESSAGE_FORBIDDEN')
    }
    this.requireConversationAccess(principal, message.conversationId, action)
    return message
  }

  private ensureConversation(
    reservationId: string,
    principal: TmCommPrincipal,
    now: number
  ): TmCommConversation {
    const existing = this.store.findConversationByReservation(reservationId)
    if (existing !== null) {
      if (!existing.participantPrincipalIds.includes(principal.id)) {
        throw tmCommForbidden('CONVERSATION_PARTICIPANT_MISSING')
      }
      return existing
    }
    const operator = this.store.findOperatorPrincipal()
    if (operator === null) {
      throw new TmCommError(
        TM_COMM_ERROR_CODES.INVALID_INPUT,
        500,
        'Operator principal is not provisioned.',
        'OPERATOR_MISSING'
      )
    }
    const conversation: TmCommConversation = {
      id: createTmCommId('conversation'),
      reservationId,
      participantPrincipalIds: Object.freeze([principal.id, operator.id]),
      createdAt: now
    }
    this.store.insertConversation(conversation)
    return conversation
  }

  private deny(
    principal: TmCommPrincipal | null,
    action: string,
    resourceType: string,
    resourceId: string | null,
    reasonCode: string
  ): void {
    this.audit({
      at: this.now(),
      actorPrincipalId: principal?.id ?? null,
      action,
      resourceType,
      resourceId,
      outcome: 'deny',
      reasonCode
    })
  }

  private audit(input: {
    at: number
    actorPrincipalId: string | null
    action: string
    resourceType: string
    resourceId: string | null
    outcome: 'allow' | 'deny'
    reasonCode: string
  }): void {
    this.store.insertAudit(createAuditEvent(input))
  }
}
