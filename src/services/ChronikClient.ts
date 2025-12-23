import { ChronikClient } from 'chronik-client'
import { CHRONIK_ENDPOINTS } from './XolosWalletService'

let chronikSingleton: ChronikClient | null = null

export function getChronik(): ChronikClient {
  if (!chronikSingleton) {
    chronikSingleton = new ChronikClient(CHRONIK_ENDPOINTS)
  }
  return chronikSingleton
}
