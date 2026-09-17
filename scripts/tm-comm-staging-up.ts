import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { bootstrapTmCommStaging, writeTmCommBootstrapReceipt } from '../server/tmComm/tmCommBootstrap.ts'
import { loadTmCommRuntimeConfig } from '../server/tmComm/tmCommConfig.ts'
import { createTmCommHttpServer, listenTmCommHttpServer } from '../server/tmComm/tmCommHttp.ts'
import { TmCommService } from '../server/tmComm/tmCommService.ts'
import { TmCommStore } from '../server/tmComm/tmCommStore.ts'
import { createTmCommEphemeralWallet } from '../server/tmComm/tmCommTestUtils.ts'

const dataDirectory = resolve('.tmp/tm-comm-staging')
mkdirSync(dataDirectory, { recursive: true, mode: 0o700 })

const config = loadTmCommRuntimeConfig({
  databasePath: resolve(dataDirectory, 'tm-comm-a0.sqlite'),
  expectedOrigin: process.env.TM_COMM_EXPECTED_ORIGIN ?? 'http://127.0.0.1:5174',
  listenHost: '127.0.0.1',
  listenPort: Number.parseInt(process.env.TM_COMM_LISTEN_PORT ?? '4178', 10)
})

const operator = createTmCommEphemeralWallet()
writeFileSync(
  resolve(dataDirectory, 'operator-wallet.json'),
  `${JSON.stringify({
    notice: 'STAGING ONLY. Fictitious operator wallet. Never a production key.',
    address: operator.address,
    publicKeyHex: operator.publicKeyHex
  }, null, 2)}\n`,
  { encoding: 'utf8', mode: 0o600 }
)

const store = new TmCommStore(config.databasePath)
const bootstrap = bootstrapTmCommStaging(store, config, {
  address: operator.address,
  publicKeyHex: operator.publicKeyHex
})
const receiptPath = writeTmCommBootstrapReceipt(dataDirectory, {
  environment: 'staging',
  databasePath: config.databasePath,
  expectedOrigin: config.expectedOrigin,
  operatorPrincipalId: bootstrap.operatorPrincipalId,
  operatorAddress: bootstrap.operatorAddress,
  enrollments: bootstrap.enrollments,
  notice: 'Fictitious Xolos Ramírez enrollment tokens. Not production. Not real guests.'
})

const service = new TmCommService(store, config)
const server = await listenTmCommHttpServer(createTmCommHttpServer(service, config), config)

console.log('TM-COMM A0 staging is up.')
console.log(`API: ${server.tmCommBaseUrl}/v1/tm-comm/health`)
console.log('UI:  http://127.0.0.1:5174/tm-comm-staging')
console.log(`DB:  ${config.databasePath}`)
console.log(`Bootstrap receipt: ${receiptPath}`)
console.log('Enrollment tokens are in the receipt. They are fictitious and single-use.')
console.log('Start the UI with: VITE_TM_COMM_STAGING=true npm run dev -- --port 5174 --strictPort')
console.log('This process is independent of production. Ctrl+C to stop.')

const shutdown = () => {
  server.close()
  store.close()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
