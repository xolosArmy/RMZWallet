import { ChronikClient } from 'chronik-client'

const DEFAULT_CHRONIK_URLS = ['https://chronik.xolosarmy.xyz', 'https://chronik.e.cash']

const getEnv = (name: string): string | undefined => {
  const viteEnv = (import.meta as any)?.env
  if (viteEnv && typeof viteEnv === 'object' && name in viteEnv) {
    return viteEnv[name]
  }
  if (typeof process !== 'undefined' && process?.env) {
    return process.env[name]
  }
  return undefined
}

const resolveChronikUrls = (): string[] => {
  const configured = getEnv('VITE_CHRONIK_URL') || getEnv('CHRONIK_URL')
  if (!configured) {
    return DEFAULT_CHRONIK_URLS
  }
  const urls = configured
    .split(',')
    .map((url: string) => url.trim())
    .filter(Boolean)
  return urls.length > 0 ? urls : DEFAULT_CHRONIK_URLS
}

let chronikClient: ChronikClient | null = null

export function getChronik(): ChronikClient {
  if (!chronikClient) {
    chronikClient = new ChronikClient(resolveChronikUrls())
  }
  return chronikClient
}
