import {
  parseWalletApprovalRequestV1,
  type WalletApprovalRequestV1
} from '@xolosarmy/tonalli-core'
import {
  AGENT_WALLET_HANDOFF_FORMAT_VERSION,
  AGENT_WALLET_HANDOFF_MAGIC,
  MAX_EFFECTIVE_CONTENT_BYTES
} from './constants'
import { encodeAgentWalletHandoffV1 } from './encoder'
import { AgentWalletHandoffCodecError } from './errors'
import { AgentWalletHandoffReader, equalBytes } from './primitives'

export function decodeAgentWalletHandoffV1(content: Uint8Array): WalletApprovalRequestV1 {
  if (!(content instanceof Uint8Array)) {
    throw new AgentWalletHandoffCodecError('INVALID_INPUT_TYPE')
  }
  if (content.length > MAX_EFFECTIVE_CONTENT_BYTES) {
    throw new AgentWalletHandoffCodecError('CONTENT_TOO_LARGE')
  }

  const snapshot = new Uint8Array(content)
  const reader = new AgentWalletHandoffReader(snapshot)
  reader.readAndMatchMagic(AGENT_WALLET_HANDOFF_MAGIC)
  if (reader.readUint16() !== AGENT_WALLET_HANDOFF_FORMAT_VERSION) {
    throw new AgentWalletHandoffCodecError('UNSUPPORTED_VERSION')
  }

  const contractVersion = reader.readLpAscii()
  const kind = reader.readLpAscii()
  const purpose = reader.readLpAscii()
  const requestId = reader.readLpAscii()

  const intentContractVersion = reader.readLpAscii()
  const intentKind = reader.readLpAscii()
  const intentId = reader.readLpAscii()
  const nonce = reader.readLpAscii()
  const agentId = reader.readLpAscii()
  const agentRole = reader.readLpAscii()
  const network = reader.readLpAscii()
  const fromAddress = reader.readLpAscii()
  const toAddress = reader.readLpAscii()
  const amountSats = reader.readDecimal()
  const reason = reader.readLpUtf8()
  const memoPresent = reader.readPresence()
  const memo = memoPresent ? reader.readLpUtf8() : undefined
  const createdAt = reader.readUint64()
  const intentExpiresAt = reader.readUint64()

  const policyContractVersion = reader.readLpAscii()
  const policyKind = reader.readLpAscii()
  const decisionId = reader.readLpAscii()
  const policyIntentId = reader.readLpAscii()
  const decision = reader.readLpAscii()
  const reasonCode = reader.readLpAscii()
  const policyReason = reader.readLpUtf8()
  const policyTraceId = reader.readLpAscii()
  const policyVersion = reader.readLpAscii()
  const evaluatedAt = reader.readUint64()
  const policyExpiresAt = reader.readUint64()

  const x402Present = reader.readPresence()
  const x402 = x402Present
    ? {
        x402Version: reader.readUint16(),
        scheme: reader.readLpAscii(),
        network: reader.readLpAscii(),
        invoiceHash: reader.readHash(),
        resourceHash: reader.readHash(),
        amountSats: reader.readDecimal(),
        payTo: reader.readLpAscii(),
        nonce: reader.readLpAscii(),
        issuedAt: reader.readUint64(),
        expiresAt: reader.readUint64()
      }
    : undefined

  const requestedAt = reader.readUint64()
  const expiresAt = reader.readUint64()
  reader.assertEof()

  const candidate = {
    contractVersion,
    kind,
    purpose,
    requestId,
    intent: {
      contractVersion: intentContractVersion,
      kind: intentKind,
      intentId,
      nonce,
      agentId,
      agentRole,
      network,
      fromAddress,
      toAddress,
      amountSats,
      reason,
      ...(memo === undefined ? {} : { memo }),
      createdAt,
      expiresAt: intentExpiresAt
    },
    policyDecision: {
      contractVersion: policyContractVersion,
      kind: policyKind,
      decisionId,
      intentId: policyIntentId,
      decision,
      reasonCode,
      reason: policyReason,
      policyTraceId,
      policyVersion,
      evaluatedAt,
      expiresAt: policyExpiresAt
    },
    ...(x402 === undefined ? {} : { x402 }),
    requestedAt,
    expiresAt
  }

  let parsed: WalletApprovalRequestV1
  try {
    parsed = parseWalletApprovalRequestV1(candidate)
  } catch (cause) {
    throw new AgentWalletHandoffCodecError('DECODED_VALUE_INVALID', cause)
  }

  if (!equalBytes(encodeAgentWalletHandoffV1(parsed), snapshot)) {
    throw new AgentWalletHandoffCodecError('NON_CANONICAL_CONTENT')
  }
  return parsed
}
