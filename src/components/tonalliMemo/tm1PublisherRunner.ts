import {
  createTm1RegtestE2eHarness,
  type Tm1ProgrammaticE2eOptions,
  Tm1RegtestE2eHarness
} from '../../integrations/tonalliMemo/tm1RegtestE2eHarness'
import type { Tm1PublisherExecutor } from './types'

/**
 * Concrete Tm1PublisherExecutor adapter wrapping Tm1RegtestE2eHarness.
 * Consumes only exposed public methods, preserving strict separation of concerns.
 */
export class HarnessPublisherExecutor implements Tm1PublisherExecutor {
  private harness: Tm1RegtestE2eHarness
  private options: Tm1ProgrammaticE2eOptions

  constructor(options: Tm1ProgrammaticE2eOptions = {}) {
    this.options = { ...options }
    this.harness = createTm1RegtestE2eHarness(this.options)
  }

  getHarness(): Tm1RegtestE2eHarness {
    return this.harness
  }

  async verifyOwnership(
    alias: string,
    ownerAddress: string,
    signal?: AbortSignal
  ): Promise<object> {
    if (alias !== this.options.alias || ownerAddress !== this.options.ownerAddress) {
      this.options = { ...this.options, alias, ownerAddress }
      this.harness = createTm1RegtestE2eHarness(this.options)
    }
    // Step 1: verify alias
    const evidenceToken = await this.harness.executeStep1VerifyAlias(signal)
    // Step 2: produce evidence snapshot
    this.harness.executeStep2ProduceEvidence(evidenceToken)
    return evidenceToken
  }

  async requestAuthorization(
    evidenceToken: object
  ): Promise<object> {
    // Step 3: authorize publication
    return this.harness.executeStep3AuthorizePublication(
      evidenceToken as Parameters<typeof this.harness.executeStep3AuthorizePublication>[0]
    )
  }

  async prepareAndSign(
    auth: object,
    message: string,
    signal?: AbortSignal
  ): Promise<{
    preparedReview: object
    signedReview: object
  }> {
    if (message !== this.options.message) {
      this.options = { ...this.options, message }
      this.harness = createTm1RegtestE2eHarness(this.options)
    }
    // Step 4: prepare memo and candidate transaction
    const step4 = await this.harness.executeStep4PrepareMemoAndUnsignedTx(
      auth as Parameters<typeof this.harness.executeStep4PrepareMemoAndUnsignedTx>[0],
      signal
    )
    // Step 5: dual authorize and sign
    const step5 = await this.harness.executeStep5DualAuthorizeAndSign(
      step4.preparedReview,
      signal
    )
    return {
      preparedReview: step4.preparedReview,
      signedReview: step5.signedReview
    }
  }

  async broadcastAndFinalize(
    preparedReview: object,
    signedReview: object,
    signal?: AbortSignal
  ): Promise<{
    txid: string
    submissionId?: string
  }> {
    // Step 6: reserve recovery and dispatch exactly-once
    const step6 = await this.harness.executeStep6ReserveRecoveryAndDispatch(
      preparedReview as Parameters<typeof this.harness.executeStep6ReserveRecoveryAndDispatch>[0],
      signedReview as Parameters<typeof this.harness.executeStep6ReserveRecoveryAndDispatch>[1],
      signal
    )
    // Step 7: verify final success and confirm acknowledgement
    await this.harness.executeStep7VerifyFinalSuccess(
      preparedReview as Parameters<typeof this.harness.executeStep7VerifyFinalSuccess>[0],
      signedReview as Parameters<typeof this.harness.executeStep7VerifyFinalSuccess>[1],
      step6.submissionReceipt,
      step6.witnessReservationSnapshot,
      signal
    )
    return {
      txid: step6.submissionReceipt.txid,
      submissionId: step6.submissionReceipt.submissionId
    }
  }
}

export function createHarnessPublisherExecutor(
  options: Tm1ProgrammaticE2eOptions = {}
): Tm1PublisherExecutor {
  return new HarnessPublisherExecutor(options)
}
