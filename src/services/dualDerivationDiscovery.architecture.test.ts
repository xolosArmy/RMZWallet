import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const source = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), 'utf8')

describe('dual derivation discovery security boundary', () => {
  test('discovery and public derivation do not extract keys, sign or broadcast', () => {
    const runtime = [
      source('./derivationProfiles.ts'),
      source('./dualDerivationDiscovery.ts')
    ].join('\n')

    expect(runtime).not.toMatch(/\.seckey\s*\(/)
    expect(runtime).not.toMatch(/getSignatory\s*\(/)
    expect(runtime).not.toMatch(/withPrivateKey\s*\(/)
    expect(runtime).not.toMatch(/signTxBuilder\s*\(/)
    expect(runtime).not.toMatch(/broadcastTx\s*\(/)
  })

  test('wallet scans use the public derivation boundary and reserve private derivation for signing', () => {
    const service = source('./XolosWalletService.ts')
    const ownerBoundary = service.slice(
      service.indexOf('private deriveHdOwner'),
      service.indexOf('private rememberHdOwners')
    )
    const rescanBoundary = service.slice(
      service.indexOf('private async scanAddressesForRescan'),
      service.lastIndexOf('\n}')
    )

    expect(ownerBoundary).toContain('derivePublicMetadata(')
    expect(ownerBoundary).not.toContain('deriveFromMnemonic(')
    expect(rescanBoundary).toContain('derivePublicMetadata(')
    expect(rescanBoundary).not.toContain('deriveFromMnemonic(')
  })

  test('runtime consumers do not embed either BIP44 profile path', () => {
    const consumers = [
      source('./XolosWalletService.ts'),
      source('./firmaAlphaSend.ts'),
      source('../routes/Onboarding.tsx'),
      source('../routes/Settings.tsx')
    ].join('\n')

    expect(consumers).not.toContain("m/44'/899'")
    expect(consumers).not.toContain("m/44'/1899'")
  })
})
