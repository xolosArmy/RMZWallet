import { describe, expect, test } from 'vitest'
import { TmCommError } from '../../src/features/privateMessaging/errors'
import { assertTmCommStagingPath, loadTmCommRuntimeConfig } from './tmCommConfig'
import { TmCommService } from './tmCommService'
import { TmCommStore } from './tmCommStore'
import { createTmCommEphemeralWallet } from './tmCommTestUtils'

describe('TM-COMM auth and staging containment', () => {
  test('refuses production-looking database paths', () => {
    expect(() => assertTmCommStagingPath('/var/production/tm-comm.sqlite')).toThrow(
      /production/
    )
  })

  test('expired challenge cannot mint a session', () => {
    let now = 50_000
    const origin = 'http://tm-comm.staging.test'
    const store = new TmCommStore(':memory:')
    const config = loadTmCommRuntimeConfig({
      databasePath: ':memory:',
      expectedOrigin: origin,
      challengeTtlMs: 1_000
    })
    const service = new TmCommService(store, config, () => now)
    const wallet = createTmCommEphemeralWallet()
    const challenge = service.createChallenge(origin)
    now = challenge.expiresAt + 1
    try {
      expect(() => service.createSession({
        challengeId: challenge.challengeId,
        address: wallet.address,
        publicKeyHex: wallet.publicKeyHex,
        signature: wallet.sign(challenge.canonicalMessage),
        requestOrigin: origin
      })).toThrow(TmCommError)
    } finally {
      store.close()
    }
  })

  test('runtime config is staging and never production', () => {
    const config = loadTmCommRuntimeConfig({
      databasePath: ':memory:'
    })
    expect(config.environment).toBe('staging')
    expect(config.cookieName).toBe('tm_comm_a0_session')
  })
})
