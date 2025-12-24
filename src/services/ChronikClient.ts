import { ChronikClient } from 'chronik-client'

const DEFAULT_CHRONIK_URLS = ['https://chronik.e.cash', 'https://chronik.paybutton.org']

const resolveChronikUrls = (): string[] => {
  const configured = import.meta.env?.VITE_CHRONIK_URL
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
