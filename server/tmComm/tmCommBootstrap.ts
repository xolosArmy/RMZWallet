import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TM_COMM_ERROR_CODES, TmCommError } from '../../src/features/privateMessaging/errors'
import type { TmCommRuntimeConfig } from './tmCommConfig'
import { createTmCommId, createTmCommSecretHex } from './tmCommIds'
import type { TmCommStore } from './tmCommStore'
import { sha256Hex } from './tmCommVerify'

export type TmCommIssuedEnrollment = Readonly<{
  reservationId: string
  label: 'client-a' | 'client-b'
  expectedEmail: string
  enrollmentToken: string
  enrollmentTokenId: string
}>

export type TmCommBootstrapResult = Readonly<{
  operatorPrincipalId: string
  operatorAddress: string
  enrollments: readonly TmCommIssuedEnrollment[]
}>

export function bootstrapTmCommStaging(
  store: TmCommStore,
  config: TmCommRuntimeConfig,
  operator: { address: string; publicKeyHex: string },
  now: () => number = () => Date.now()
): TmCommBootstrapResult {
  const createdAt = now()
  const existingOperator = store.findOperatorPrincipal()
  if (existingOperator) {
    if (
      existingOperator.walletAddress !== operator.address ||
      existingOperator.publicKeyHex.toLowerCase() !== operator.publicKeyHex.trim().toLowerCase()
    ) {
      throw new TmCommError(
        TM_COMM_ERROR_CODES.CONFLICT,
        409,
        'Existing operator principal in database does not match provided operator credential.',
        'OPERATOR_IDENTITY_MISMATCH'
      )
    }
  }
  const operatorPrincipal = existingOperator ?? store.insertPrincipal({
    id: createTmCommId('principal'),
    kind: 'operator',
    walletAddress: operator.address,
    publicKeyHex: operator.publicKeyHex.trim().toLowerCase(),
    createdAt
  })

  const enrollments: TmCommIssuedEnrollment[] = []
  const fixtures: Array<{
    label: 'client-a' | 'client-b'
    reservationId: string
    expectedEmail: string
  }> = [
    {
      label: 'client-a',
      reservationId: 'rsv_staging_client_a',
      expectedEmail: 'client-a.staging@invalid.test'
    },
    {
      label: 'client-b',
      reservationId: 'rsv_staging_client_b',
      expectedEmail: 'client-b.staging@invalid.test'
    }
  ]

  for (const fixture of fixtures) {
    const enrollmentToken = createTmCommSecretHex(24)
    const enrollmentTokenId = createTmCommId('enrollment')
    store.insertEnrollment({
      id: enrollmentTokenId,
      tokenHash: sha256Hex(enrollmentToken),
      reservationId: fixture.reservationId,
      expectedEmail: fixture.expectedEmail,
      issuedBy: 'xolos-ramirez-operator',
      expiresAt: createdAt + config.enrollmentTtlMs,
      consumedAt: null,
      consumedByPrincipalId: null,
      createdAt
    })
    enrollments.push({
      reservationId: fixture.reservationId,
      label: fixture.label,
      expectedEmail: fixture.expectedEmail,
      enrollmentToken,
      enrollmentTokenId
    })
  }

  return Object.freeze({
    operatorPrincipalId: operatorPrincipal.id,
    operatorAddress: operatorPrincipal.walletAddress,
    enrollments: Object.freeze(enrollments)
  })
}

export function writeTmCommBootstrapReceipt(
  dataDirectory: string,
  receipt: Record<string, unknown>
): string {
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 })
  const receiptPath = join(dataDirectory, 'bootstrap-receipt.json')
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  })
  return receiptPath
}
