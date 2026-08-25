import { ChronikClient } from 'chronik-client'

const DEFAULT_CHRONIK_URLS = ['https://chronik.e.cash', 'https://chronik.xolosarmy.xyz']
// Bitcoin ABC's Cashtab nodes are indexed with the agora.py plugin.
const DEFAULT_AGORA_CHRONIK_URLS = [
  'https://chronik-native2.fabien.cash',
  'https://chronik-native3.fabien.cash',
  'https://chronik-native1.fabien.cash'
]

type ViteEnv = Record<string, string | undefined> & { DEV?: boolean }

const getEnv = (name: string): string | undefined => {
  const viteEnv = (import.meta as unknown as { env?: ViteEnv }).env ?? {}
  if (name in viteEnv) {
    return viteEnv[name]
  }
  const nodeEnv = (typeof process !== 'undefined' ? (process as { env?: ViteEnv }).env : undefined) ?? {}
  if (name in nodeEnv) {
    return nodeEnv[name]
  }
  return undefined
}

const parseChronikUrls = (configured: string | undefined, defaults: string[]): string[] => {
  if (!configured) {
    return defaults
  }
  const urls = configured
    .split(',')
    .map((url: string) => url.trim())
    .filter(Boolean)
  return urls.length > 0 ? urls : defaults
}

const resolveChronikUrls = () =>
  parseChronikUrls(getEnv('VITE_CHRONIK_URL') || getEnv('CHRONIK_URL'), DEFAULT_CHRONIK_URLS)

export const getChronikUrls = (): readonly string[] => [...resolveChronikUrls()]

const resolveAgoraChronikUrls = () =>
  parseChronikUrls(
    getEnv('VITE_AGORA_CHRONIK_URL') || getEnv('AGORA_CHRONIK_URL'),
    DEFAULT_AGORA_CHRONIK_URLS
  )

let chronikClient: ChronikClient | null = null
let agoraChronikClient: ChronikClient | null = null

export function getChronik(): ChronikClient {
  if (!chronikClient) {
    chronikClient = new ChronikClient(resolveChronikUrls())
  }
  return chronikClient
}

/** Chronik client whose endpoints must expose the Agora plugin index. */
export function getAgoraChronik(): ChronikClient {
  if (!agoraChronikClient) {
    agoraChronikClient = new ChronikClient(resolveAgoraChronikUrls())
  }
  return agoraChronikClient
}
