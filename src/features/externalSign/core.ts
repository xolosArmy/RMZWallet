import type {
  UniversalAuthorizationAdapter,
  UniversalReviewSnapshot,
  UniversalSignedResult
} from './adapters'
import {
  InMemoryApprovalCapability,
  type ApprovalConsumptionLedger
} from './approval'
import {
  calculateUniversalContentHash,
  equalUniversalContentHashes,
  type UniversalContentHash
} from './contentHash'
import {
  parseUniversalAuthorizationEnvelope,
  UniversalAuthorizationError,
  type UniversalAuthorizationEnvelopeV1
} from './contract'
import type { UniversalOperationLease, UniversalOperationLock } from './lock'

export type UniversalAuthorizationState =
  | 'disabled'
  | 'receiving'
  | 'preparing'
  | 'reviewReady'
  | 'approving'
  | 'revalidating'
  | 'signing'
  | 'completed'
  | 'rejected'
  | 'expired'
  | 'aborted'
  | 'failed'

export type UniversalTerminalState = Extract<
  UniversalAuthorizationState,
  'completed' | 'rejected' | 'expired' | 'aborted' | 'failed'
>

export const UNIVERSAL_STATE_TRANSITIONS = Object.freeze({
  disabled: ['receiving', 'expired', 'aborted', 'failed'] as const,
  receiving: ['preparing', 'expired', 'aborted', 'failed'] as const,
  preparing: ['reviewReady', 'expired', 'aborted', 'failed'] as const,
  reviewReady: ['approving', 'rejected', 'expired', 'aborted', 'failed'] as const,
  approving: ['revalidating', 'rejected', 'expired', 'aborted', 'failed'] as const,
  revalidating: ['signing', 'rejected', 'expired', 'aborted', 'failed'] as const,
  signing: ['completed', 'failed'] as const,
  completed: [] as const,
  rejected: [] as const,
  expired: [] as const,
  aborted: [] as const,
  failed: [] as const
}) satisfies Readonly<Record<UniversalAuthorizationState, readonly UniversalAuthorizationState[]>>

export type PreparedUniversalAuthorization = Readonly<{
  operationId: string
  review: UniversalReviewSnapshot
  contentHash: UniversalContentHash
}>

type Deferred<T> = Readonly<{
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
  isSettled: () => boolean
}>

const deferred = <T>(): Deferred<T> => {
  let resolvePromise: (value: T) => void = () => undefined
  let rejectPromise: (reason: unknown) => void = () => undefined
  let settled = false
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = value => {
      if (settled) return
      settled = true
      resolve(value)
    }
    rejectPromise = reason => {
      if (settled) return
      settled = true
      reject(reason)
    }
  })
  void promise.catch(() => undefined)
  return Object.freeze({
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
    isSettled: () => settled
  })
}

type OperationContext = {
  readonly envelope: UniversalAuthorizationEnvelopeV1
  readonly adapter: UniversalAuthorizationAdapter
  readonly controller: AbortController
  readonly ready: Deferred<PreparedUniversalAuthorization>
  readonly history: UniversalAuthorizationState[]
  state: UniversalAuthorizationState
  lease: UniversalOperationLease | null
  capability: InMemoryApprovalCapability | null
  review: UniversalReviewSnapshot | null
  contentHash: UniversalContentHash | null
  expiryTimer: ReturnType<typeof setTimeout> | null
  signInvoked: boolean
  finalized: boolean
  cleanupDone: boolean
}

export type UniversalOperationHandle = Readonly<{
  operationId: string
  ready: Promise<PreparedUniversalAuthorization>
  approve: () => Promise<UniversalSignedResult>
  reject: () => void
  abort: () => void
  cleanup: () => void
  state: () => UniversalAuthorizationState
  history: () => readonly UniversalAuthorizationState[]
}>

export type UniversalAuthorizationCoreDependencies = Readonly<{
  enabled: boolean
  lock: UniversalOperationLock
  approvalLedger: ApprovalConsumptionLedger
  now?: () => number
  createCapabilityId?: (operationId: string) => string
  calculateHash?: typeof calculateUniversalContentHash
}>

const reviewsEqual = (left: UniversalReviewSnapshot, right: UniversalReviewSnapshot): boolean => {
  if (left.fields.length !== right.fields.length) return false
  if (left.effectiveContent.length !== right.effectiveContent.length) return false
  for (let index = 0; index < left.fields.length; index += 1) {
    if (
      left.fields[index].label !== right.fields[index].label ||
      left.fields[index].value !== right.fields[index].value
    ) return false
  }
  let difference = 0
  for (let index = 0; index < left.effectiveContent.length; index += 1) {
    difference |= left.effectiveContent[index] ^ right.effectiveContent[index]
  }
  return difference === 0
}

const cloneReview = (snapshot: UniversalReviewSnapshot): UniversalReviewSnapshot => Object.freeze({
  fields: Object.freeze(snapshot.fields.map(field => Object.freeze({
    label: field.label,
    value: field.value
  }))),
  effectiveContent: new Uint8Array(snapshot.effectiveContent)
})

const randomCapabilityId = (operationId: string): string => {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32))
  const suffix = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${operationId}:${suffix}`
}

export class UniversalAuthorizationCore {
  private readonly dependencies: UniversalAuthorizationCoreDependencies
  private readonly now: () => number
  private readonly createCapabilityId: (operationId: string) => string
  private readonly calculateHash: typeof calculateUniversalContentHash
  private active: OperationContext | null = null

  constructor(dependencies: UniversalAuthorizationCoreDependencies) {
    this.dependencies = dependencies
    this.now = dependencies.now ?? Date.now
    this.createCapabilityId = dependencies.createCapabilityId ?? randomCapabilityId
    this.calculateHash = dependencies.calculateHash ?? calculateUniversalContentHash
  }

  get activeOperationId(): string | null {
    return this.active?.envelope.operationId ?? null
  }

  start(
    envelope: unknown,
    adapter: UniversalAuthorizationAdapter
  ): UniversalOperationHandle {
    if (!this.dependencies.enabled) throw new UniversalAuthorizationError('AUTHORIZATION_DISABLED')
    if (this.active) throw new UniversalAuthorizationError('OPERATION_ALREADY_ACTIVE')
    const validatedEnvelope = parseUniversalAuthorizationEnvelope(envelope, this.now())
    if (validatedEnvelope.profileId !== adapter.profileId) {
      throw new UniversalAuthorizationError('PROFILE_MISMATCH')
    }

    const context: OperationContext = {
      envelope: validatedEnvelope,
      adapter,
      controller: new AbortController(),
      ready: deferred<PreparedUniversalAuthorization>(),
      history: ['disabled'],
      state: 'disabled',
      lease: null,
      capability: null,
      review: null,
      contentHash: null,
      expiryTimer: null,
      signInvoked: false,
      finalized: false,
      cleanupDone: false
    }
    this.active = context
    context.expiryTimer = setTimeout(
      () => this.expire(context),
      Math.max(0, validatedEnvelope.expiresAt - this.now())
    )
    void this.prepare(context)

    return Object.freeze({
      operationId: validatedEnvelope.operationId,
      ready: context.ready.promise,
      approve: () => this.approve(context),
      reject: () => this.reject(context),
      abort: () => this.abort(context),
      cleanup: () => this.abort(context),
      state: () => context.state,
      history: () => Object.freeze([...context.history])
    })
  }

  replace(
    envelope: unknown,
    adapter: UniversalAuthorizationAdapter
  ): UniversalOperationHandle {
    if (this.active) this.abort(this.active)
    return this.start(envelope, adapter)
  }

  abortOperation(operationId: string): void {
    const context = this.active
    if (!context || context.envelope.operationId !== operationId) return
    this.abort(context)
  }

  private async prepare(context: OperationContext): Promise<void> {
    try {
      const lease = await this.dependencies.lock.acquire(
        context.envelope.operationId,
        context.controller.signal
      )
      if (context.finalized) {
        this.releaseDetachedLease(context, lease)
        return
      }
      context.lease = lease
      this.transition(context, 'disabled', 'receiving')
      this.transition(context, 'receiving', 'preparing')
      const adapterReview = await this.awaitWithAbort(
        context.adapter.prepareReview(context.envelope, context.controller.signal),
        context.controller.signal
      )
      this.assertContinuation(context, 'preparing')
      const review = cloneReview(adapterReview)
      const contentHash = await this.calculateHash(
        context.envelope,
        review.effectiveContent,
        context.controller.signal
      )
      this.assertContinuation(context, 'preparing')
      context.review = review
      context.contentHash = contentHash
      this.transition(context, 'preparing', 'reviewReady')
      context.ready.resolve(Object.freeze({
        operationId: context.envelope.operationId,
        review: cloneReview(review),
        contentHash
      }))
    } catch (error) {
      this.failUnlessFinalized(context, error)
    }
  }

  private approve(context: OperationContext): Promise<UniversalSignedResult> {
    this.transition(context, 'reviewReady', 'approving')
    if (!context.review || !context.contentHash || context.capability) {
      this.enterTerminal(context, 'failed', new UniversalAuthorizationError('INVALID_APPROVAL_CONTEXT'))
      throw new UniversalAuthorizationError('INVALID_APPROVAL_CONTEXT')
    }
    context.capability = new InMemoryApprovalCapability(
      context.envelope.operationId,
      this.createCapabilityId(context.envelope.operationId),
      context.contentHash,
      context.envelope.expiresAt
    )
    this.transition(context, 'approving', 'revalidating')
    return this.revalidateAndSign(context)
  }

  private async revalidateAndSign(context: OperationContext): Promise<UniversalSignedResult> {
    try {
      const approvedReview = context.review
      const approvedHash = context.contentHash
      const capability = context.capability
      if (!approvedReview || !approvedHash || !capability) {
        throw new UniversalAuthorizationError('INVALID_APPROVAL_CONTEXT')
      }
      const finalReview = await this.awaitWithAbort(
        context.adapter.revalidateReview(
          context.envelope,
          cloneReview(approvedReview),
          context.controller.signal
        ),
        context.controller.signal
      )
      this.assertContinuation(context, 'revalidating')
      const safeFinalReview = cloneReview(finalReview)
      const finalHash = await this.calculateHash(
        context.envelope,
        safeFinalReview.effectiveContent,
        context.controller.signal
      )
      this.assertContinuation(context, 'revalidating')
      if (
        !reviewsEqual(approvedReview, safeFinalReview) ||
        !equalUniversalContentHashes(approvedHash, finalHash) ||
        capability.operationId !== context.envelope.operationId ||
        !equalUniversalContentHashes(capability.contentHash, approvedHash)
      ) {
        throw new UniversalAuthorizationError('CONTENT_BINDING_MISMATCH')
      }
      await this.awaitWithAbort(
        capability.consume(
          this.dependencies.approvalLedger,
          context.controller.signal,
          this.now()
        ),
        context.controller.signal
      )
      this.assertContinuation(context, 'revalidating')
      if (capability.state !== 'consumed') throw new UniversalAuthorizationError('APPROVAL_NOT_CONSUMED')
      this.transition(context, 'revalidating', 'signing')
      if (context.signInvoked) throw new UniversalAuthorizationError('SIGN_ALREADY_INVOKED')
      context.signInvoked = true
      const signedResult = await context.adapter.signApprovedContent(Object.freeze({
        envelope: context.envelope,
        effectiveContent: new Uint8Array(safeFinalReview.effectiveContent),
        contentHash: finalHash,
        signal: context.controller.signal
      }))
      this.assertSigningCompletion(context)
      if (!equalUniversalContentHashes(signedResult.contentHash, finalHash)) {
        throw new UniversalAuthorizationError('SIGNED_RESULT_HASH_MISMATCH')
      }
      const safeSignedResult = Object.freeze({
        format: signedResult.format,
        bytes: new Uint8Array(signedResult.bytes),
        contentHash: signedResult.contentHash
      })
      this.enterTerminal(context, 'completed')
      return safeSignedResult
    } catch (error) {
      this.failUnlessFinalized(context, error)
      throw error
    }
  }

  private transition(
    context: OperationContext,
    expected: UniversalAuthorizationState,
    next: UniversalAuthorizationState
  ): void {
    this.assertContinuation(context, expected)
    const allowed = UNIVERSAL_STATE_TRANSITIONS[expected] as readonly UniversalAuthorizationState[]
    if (!allowed.includes(next)) {
      throw new UniversalAuthorizationError('INVALID_STATE_TRANSITION')
    }
    context.state = next
    context.history.push(next)
  }

  private assertContinuation(context: OperationContext, expected: UniversalAuthorizationState): void {
    if (
      this.active !== context ||
      this.active.envelope.operationId !== context.envelope.operationId
    ) throw new UniversalAuthorizationError('OPERATION_OWNERSHIP_LOST')
    if (context.state !== expected) throw new UniversalAuthorizationError('UNEXPECTED_OPERATION_STATE')
    if (context.controller.signal.aborted) throw new UniversalAuthorizationError('OPERATION_ABORTED')
    if (
      !context.lease ||
      context.lease.ownerOperationId !== context.envelope.operationId ||
      !context.lease.isOwned()
    ) throw new UniversalAuthorizationError('LEASE_NOT_OWNED')
    if (this.now() >= context.envelope.expiresAt) {
      this.enterTerminal(context, 'expired')
      throw new UniversalAuthorizationError('REQUEST_EXPIRED')
    }
  }

  private assertSigningCompletion(context: OperationContext): void {
    if (
      this.active !== context ||
      this.active.envelope.operationId !== context.envelope.operationId
    ) throw new UniversalAuthorizationError('OPERATION_OWNERSHIP_LOST')
    if (context.state !== 'signing') throw new UniversalAuthorizationError('UNEXPECTED_OPERATION_STATE')
    if (
      !context.lease ||
      context.lease.ownerOperationId !== context.envelope.operationId ||
      !context.lease.isOwned()
    ) throw new UniversalAuthorizationError('LEASE_NOT_OWNED')
  }

  private reject(context: OperationContext): void {
    if (context.finalized) return
    if (context.state === 'signing') {
      this.signalSigningCancellation(context, 'OPERATION_REJECTED_AFTER_SIGNING')
      return
    }
    this.enterTerminal(context, 'rejected')
  }

  private abort(context: OperationContext): void {
    if (context.finalized) return
    if (context.state === 'signing') {
      this.signalSigningCancellation(context, 'OPERATION_ABORTED_AFTER_SIGNING')
      return
    }
    this.enterTerminal(context, 'aborted')
  }

  private expire(context: OperationContext): void {
    if (context.finalized || this.now() < context.envelope.expiresAt) return
    if (context.state === 'signing') {
      this.signalSigningCancellation(context, 'OPERATION_EXPIRED_AFTER_SIGNING')
      return
    }
    this.enterTerminal(context, 'expired')
  }

  private signalSigningCancellation(context: OperationContext, code: string): void {
    if (!context.controller.signal.aborted) {
      context.controller.abort(new UniversalAuthorizationError(code))
    }
  }

  private enterTerminal(
    context: OperationContext,
    requestedTerminal: UniversalTerminalState,
    reason: unknown = new UniversalAuthorizationError(`OPERATION_${requestedTerminal.toUpperCase()}`)
  ): void {
    if (context.finalized) return
    if (this.active !== context || this.active.envelope.operationId !== context.envelope.operationId) return
    const terminal = context.state !== 'signing' &&
      this.now() >= context.envelope.expiresAt &&
      requestedTerminal !== 'completed'
      ? 'expired'
      : requestedTerminal
    const allowed = UNIVERSAL_STATE_TRANSITIONS[context.state] as readonly UniversalAuthorizationState[]
    if (!allowed.includes(terminal)) {
      throw new UniversalAuthorizationError('INVALID_STATE_TRANSITION')
    }
    if (context.state !== 'disabled') {
      if (
        !context.lease ||
        context.lease.ownerOperationId !== context.envelope.operationId ||
        !context.lease.isOwned()
      ) throw new UniversalAuthorizationError('LEASE_NOT_OWNED')
    }
    context.controller.abort(reason)
    context.capability?.invalidate()
    context.state = terminal
    context.history.push(terminal)
    context.finalized = true
    if (!context.ready.isSettled()) context.ready.reject(reason)
    this.cleanup(context)
  }

  private cleanup(context: OperationContext): void {
    if (context.cleanupDone) return
    context.cleanupDone = true
    if (context.expiryTimer) clearTimeout(context.expiryTimer)
    context.expiryTimer = null
    const lease = context.lease
    context.lease = null
    if (
      lease &&
      lease.ownerOperationId === context.envelope.operationId &&
      lease.isOwned()
    ) lease.release()
    context.capability = null
    context.review = null
    context.contentHash = null
    if (this.active === context) this.active = null
  }

  private releaseDetachedLease(context: OperationContext, lease: UniversalOperationLease): void {
    if (
      lease.ownerOperationId === context.envelope.operationId &&
      lease.isOwned()
    ) lease.release()
  }

  private failUnlessFinalized(context: OperationContext, error: unknown): void {
    if (context.finalized) return
    if (context.state === 'signing') {
      this.enterTerminal(context, 'failed', error)
      return
    }
    if (this.now() >= context.envelope.expiresAt) {
      this.enterTerminal(context, 'expired', error)
      return
    }
    this.enterTerminal(context, 'failed', error)
  }

  private awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(new UniversalAuthorizationError('OPERATION_ABORTED'))
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new UniversalAuthorizationError('OPERATION_ABORTED'))
      signal.addEventListener('abort', onAbort, { once: true })
      promise.then(
        value => {
          signal.removeEventListener('abort', onAbort)
          if (signal.aborted) reject(new UniversalAuthorizationError('OPERATION_ABORTED'))
          else resolve(value)
        },
        error => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        }
      )
    })
  }
}
