import {
  parseWalletApprovalRequestV1,
  type WalletApprovalRequestV1
} from '@xolosarmy/tonalli-core'
import {
  AGENT_WALLET_HANDOFF_FORMAT_VERSION,
  AGENT_WALLET_HANDOFF_MAGIC
} from './constants'
import { AgentWalletHandoffCodecError } from './errors'
import { AgentWalletHandoffWriter } from './primitives'

const parseInput = (value: unknown): WalletApprovalRequestV1 => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AgentWalletHandoffCodecError('INVALID_INPUT_TYPE')
  }
  try {
    return parseWalletApprovalRequestV1(value)
  } catch (cause) {
    throw new AgentWalletHandoffCodecError('INVALID_VALUE', cause)
  }
}

export function encodeAgentWalletHandoffV1(value: unknown): Uint8Array {
  const request = parseInput(value)
  const writer = new AgentWalletHandoffWriter()

  writer.writeFixedAscii(AGENT_WALLET_HANDOFF_MAGIC)
  writer.writeUint16(AGENT_WALLET_HANDOFF_FORMAT_VERSION)

  writer.writeLpAscii(request.contractVersion)
  writer.writeLpAscii(request.kind)
  writer.writeLpAscii(request.purpose)
  writer.writeLpAscii(request.requestId)

  writer.writeLpAscii(request.intent.contractVersion)
  writer.writeLpAscii(request.intent.kind)
  writer.writeLpAscii(request.intent.intentId)
  writer.writeLpAscii(request.intent.nonce)
  writer.writeLpAscii(request.intent.agentId)
  writer.writeLpAscii(request.intent.agentRole)
  writer.writeLpAscii(request.intent.network)
  writer.writeLpAscii(request.intent.fromAddress)
  writer.writeLpAscii(request.intent.toAddress)
  writer.writeDecimal(request.intent.amountSats)
  writer.writeLpUtf8(request.intent.reason)
  writer.writePresence(request.intent.memo !== undefined)
  if (request.intent.memo !== undefined) writer.writeLpUtf8(request.intent.memo)
  writer.writeUint64(request.intent.createdAt)
  writer.writeUint64(request.intent.expiresAt)

  writer.writeLpAscii(request.policyDecision.contractVersion)
  writer.writeLpAscii(request.policyDecision.kind)
  writer.writeLpAscii(request.policyDecision.decisionId)
  writer.writeLpAscii(request.policyDecision.intentId)
  writer.writeLpAscii(request.policyDecision.decision)
  writer.writeLpAscii(request.policyDecision.reasonCode)
  writer.writeLpUtf8(request.policyDecision.reason)
  writer.writeLpAscii(request.policyDecision.policyTraceId)
  writer.writeLpAscii(request.policyDecision.policyVersion)
  writer.writeUint64(request.policyDecision.evaluatedAt)
  writer.writeUint64(request.policyDecision.expiresAt)

  writer.writePresence(request.x402 !== undefined)
  if (request.x402 !== undefined) {
    writer.writeUint16(request.x402.x402Version)
    writer.writeLpAscii(request.x402.scheme)
    writer.writeLpAscii(request.x402.network)
    writer.writeHash(request.x402.invoiceHash)
    writer.writeHash(request.x402.resourceHash)
    writer.writeDecimal(request.x402.amountSats)
    writer.writeLpAscii(request.x402.payTo)
    writer.writeLpAscii(request.x402.nonce)
    writer.writeUint64(request.x402.issuedAt)
    writer.writeUint64(request.x402.expiresAt)
  }

  writer.writeUint64(request.requestedAt)
  writer.writeUint64(request.expiresAt)
  return writer.finish()
}
