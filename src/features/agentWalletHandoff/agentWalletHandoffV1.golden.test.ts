import { parseWalletApprovalRequestV1 } from '@xolosarmy/tonalli-core'
import { describe, expect, test } from 'vitest'
import {
  AGENT_WALLET_HANDOFF_V1_GOLDEN_VECTORS
} from './__fixtures__/agentWalletHandoffV1.golden'
import { decodeAgentWalletHandoffV1, encodeAgentWalletHandoffV1 } from './index'

const fromHex = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

describe('canonical Agent Wallet Handoff v1 golden vectors', () => {
  for (const vector of AGENT_WALLET_HANDOFF_V1_GOLDEN_VECTORS) {
    test(`${vector.name} matches its certified parser and wire evidence`, () => {
      const parsedFixture = parseWalletApprovalRequestV1(vector.fixture)
      const certifiedBytes = fromHex(vector.hex)
      const encoded = encodeAgentWalletHandoffV1(vector.fixture)

      expect(certifiedBytes).toHaveLength(vector.length)
      expect(encoded).toEqual(certifiedBytes)

      const decoded = decodeAgentWalletHandoffV1(certifiedBytes)
      expect(decoded).toEqual(parsedFixture)
      expect(encodeAgentWalletHandoffV1(decoded)).toEqual(certifiedBytes)
    })
  }

  test('encoder returns independent exactly-sized byte arrays', () => {
    const vector = AGENT_WALLET_HANDOFF_V1_GOLDEN_VECTORS[0]
    const first = encodeAgentWalletHandoffV1(vector.fixture)
    const second = encodeAgentWalletHandoffV1(vector.fixture)
    expect(first).not.toBe(second)
    first[0] ^= 0xff
    expect(second).toEqual(fromHex(vector.hex))
  })
})
