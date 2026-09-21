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
const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
const walletConnectSource = readFileSync(new URL('../routes/WalletConnect.tsx', import.meta.url), 'utf8')
const onboardingSource = readFileSync(new URL('../routes/Onboarding.tsx', import.meta.url), 'utf8')

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

  it('enforces WalletConnect and other privileged routes at operation and route boundaries', () => {
    expect(appSource).toContain('approveWalletConnectRequestIfAllowed')
    expect(appSource).toContain('RequireCapability capability={WALLET_CAPABILITY.WALLETCONNECT}')
    expect(appSource).toContain('RequireCapability capability={WALLET_CAPABILITY.EXTERNAL_SIGNING}')
    expect(appSource).toContain('RequireCapability capability={WALLET_CAPABILITY.AGORA_TRADING}')
    expect(appSource).toContain('RequireCapability capability={WALLET_CAPABILITY.NFT_OPERATIONS}')
    expect(appSource).toContain('RequireCapability capability={WALLET_CAPABILITY.ARBITRARY_BROADCAST}')
    expect(appSource).toContain('RequireCapability capability={WALLET_CAPABILITY.X402}')
    expect(appSource).toContain('RequireCapability capability={WALLET_CAPABILITY.TM_COMM}')
    expect(walletConnectSource).toContain('assertWalletCapabilityEnabled(wallet, WALLET_CAPABILITY.WALLETCONNECT)')
    expect(walletConnectSource).toContain('CapabilityBlocked')
    expect(onboardingSource).toContain('createBlocked')
    expect(onboardingSource).toContain('importBlocked')
    expect(walletContext).toContain('QUICK_START_RECORD_EXISTS')
    expect(walletContext).toContain('WALLET_ALREADY_INITIALIZED')
    expect(walletContext).toMatch(/restoreWallet[\s\S]*QUICK_START_WALLET_EXISTS/)
  })

  it('declares TM_COMM as a reserved future capability without implementing internals', () => {
    expect(capabilitiesSource).toContain("TM_COMM: 'TM_COMM'")
    expect(capabilitiesSource).toContain('QUICK_START_RESERVED_FUTURE_CAPABILITIES')
    expect(capabilitiesSource).toMatch(/if \(capability === WALLET_CAPABILITY\.TM_COMM\) return false/)
    const fullWalletBlock = capabilitiesSource.slice(
      capabilitiesSource.indexOf('export const FULL_WALLET_CAPABILITIES'),
      capabilitiesSource.indexOf('const QUICK_START_ALLOWED')
    )
    expect(fullWalletBlock).not.toContain('WALLET_CAPABILITY.TM_COMM')
    expect(isCapabilityAllowed(WALLET_LIFECYCLE.UNINITIALIZED, WALLET_CAPABILITY.TM_COMM)).toBe(false)
    expect(isCapabilityAllowed(WALLET_LIFECYCLE.QUICK_START_UNBACKED, WALLET_CAPABILITY.TM_COMM)).toBe(false)
    expect(isCapabilityAllowed(WALLET_LIFECYCLE.BACKUP_VERIFIED, WALLET_CAPABILITY.TM_COMM)).toBe(false)
  })
})
