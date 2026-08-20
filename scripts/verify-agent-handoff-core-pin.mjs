import { readFileSync } from 'node:fs'

const EXPECTED_SPEC =
  'github:xolosArmy/tonalli-core#cfe4cb1575b22ed258565717c000ac535aa98c67'
const EXPECTED_VERSION = '0.2.0'
const EXPECTED_RESOLVED =
  'git+ssh://git@github.com/xolosArmy/tonalli-core.git#cfe4cb1575b22ed258565717c000ac535aa98c67'

const readJson = path => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'))
const fail = message => {
  throw new Error(`Agent handoff Core pin verification failed: ${message}`)
}

const packageJson = readJson('package.json')
const packageLock = readJson('package-lock.json')
const rootPackage = packageLock.packages?.['']
const installedCore = packageLock.packages?.['node_modules/@xolosarmy/tonalli-core']

if (packageJson.dependencies?.['@xolosarmy/tonalli-core'] !== EXPECTED_SPEC) {
  fail('package.json declaration mismatch')
}
if (rootPackage?.dependencies?.['@xolosarmy/tonalli-core'] !== EXPECTED_SPEC) {
  fail('package-lock root declaration mismatch')
}
if (installedCore?.version !== EXPECTED_VERSION) {
  fail('package-lock installed version mismatch')
}
if (installedCore?.resolved !== EXPECTED_RESOLVED) {
  fail('package-lock resolved commit mismatch')
}

console.log('Agent handoff Core pin: PASS')
