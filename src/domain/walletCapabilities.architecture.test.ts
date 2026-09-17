import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  QUICK_START_ALLOWED_CAPABILITIES,
  QUICK_START_BLOCKED_CAPABILITIES,
  WALLET_CAPABILITY
} from './walletCapabilities'
import { WALLET_LIFECYCLE } from './walletLifecycle'
import { isCapabilityAllowed } from './walletCapabilities'

const walletContext = readFileSync(new URL('../context/WalletContext.tsx', import.meta.url), 'utf8')
const capabilitiesSource = readFileSync(new URL('./walletCapabilities.ts', import.meta.url), 'utf8')

describe('Quick Start capability architecture', () => {
  it('keeps privileged financial capabilities out of QUICK_START_UNBACKED', () => {
    const blocked = [
      WALLET_CAPABILITY.SEND_XEC,
      WALLET_CAPABILITY.SEND_RMZ,
      WALLET_CAPABILITY.SEND_FIRMA,
      WALLET_CAPABILITY.NFT_OPERATIONS,
      WALLET_CAPABILITY.AGORA_TRADING,
      WALLET_CAPABILITY.WALLETCONNECT,
      WALLET_CAPABILITY.X402,
      WALLET_CAPABILITY.EXTERNAL_SIGNING,
      WALLET_CAPABILITY.AGENT_WALLET_EXECUTION,
      WALLET_CAPABILITY.ARBITRARY_BROADCAST,
      WALLET_CAPABILITY.TM_COMM
    ]
    for (const capability of blocked) {
      expect(QUICK_START_ALLOWED_CAPABILITIES).not.toContain(capability)
      expect(QUICK_START_BLOCKED_CAPABILITIES).toContain(capability)
      expect(isCapabilityAllowed(WALLET_LIFECYCLE.QUICK_START_UNBACKED, capability)).toBe(false)
    }
  })

  it('keeps defense-in-depth backupVerified checks on sensitive wallet methods', () => {
    expect(walletContext).toMatch(/assertCapability\(lifecycle, WALLET_CAPABILITY\.SEND_XEC\)/)
    expect(walletContext).toMatch(/assertCapability\(lifecycle, WALLET_CAPABILITY\.SEND_RMZ\)/)
    expect(walletContext).toMatch(/assertCapability\(lifecycle, WALLET_CAPABILITY\.SEND_FIRMA\)/)
    expect(walletContext).toMatch(/assertCapability\(lifecycle, WALLET_CAPABILITY\.ALIAS_SPEND_OPERATIONS\)/)
    expect(walletContext.match(/if \(!initialized \|\| !backupVerified\)/g)?.length).toBeGreaterThanOrEqual(6)
  })

  it('declares TM_COMM as a reserved future capability without implementing internals', () => {
    expect(capabilitiesSource).toContain("TM_COMM: 'TM_COMM'")
    expect(capabilitiesSource).toContain('QUICK_START_RESERVED_FUTURE_CAPABILITIES')
    expect(isCapabilityAllowed(WALLET_LIFECYCLE.QUICK_START_UNBACKED, WALLET_CAPABILITY.TM_COMM)).toBe(false)
  })
})
