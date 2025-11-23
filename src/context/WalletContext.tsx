import type { ReactNode } from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { xolosWalletService } from '../services/XolosWalletService'
import type { WalletBalance } from '../services/XolosWalletService'

const BACKUP_KEY = 'xoloswallet_backup_verified'

export interface WalletContextValue {
  address: string | null
  balance: WalletBalance | null
  loading: boolean
  error: string | null
  initialized: boolean
  backupVerified: boolean
  createNewWallet: () => Promise<string>
  restoreWallet: (mnemonic: string) => Promise<void>
  loadExistingWallet: (password: string) => Promise<void>
  encryptAndStore: (password: string) => void
  refreshBalances: () => Promise<void>
  sendRMZ: (to: string, amount: number) => Promise<string>
   getMnemonic: () => string | null
  setBackupVerified?: (value: boolean) => void
}

const WalletContext = createContext<WalletContextValue | undefined>(undefined)

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null)
  const [balance, setBalance] = useState<WalletBalance | null>(null)
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [initialized, setInitialized] = useState<boolean>(false)
  const [backupVerified, setBackupVerifiedState] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem(BACKUP_KEY) === 'true'
  })

  useEffect(() => {
    if (typeof window === 'undefined') return
    localStorage.setItem(BACKUP_KEY, backupVerified ? 'true' : 'false')
  }, [backupVerified])

  const syncAddressAndBalance = useCallback(async () => {
    const addr = xolosWalletService.getAddress()
    setAddress(addr)
    const balances = await xolosWalletService.getBalances()
    setBalance(balances)
  }, [])

  const refreshBalances = useCallback(async () => {
    if (!initialized) return
    try {
      setLoading(true)
      await syncAddressAndBalance()
    } catch (err) {
      setError((err as Error).message)
      throw err
    } finally {
      setLoading(false)
    }
  }, [initialized, syncAddressAndBalance])

  const createNewWallet = useCallback(async (): Promise<string> => {
    setLoading(true)
    setError(null)
    try {
      const mnemonic = await xolosWalletService.createNewWallet()
      await syncAddressAndBalance()
      setInitialized(true)
      setBackupVerifiedState(false)
      localStorage.setItem(BACKUP_KEY, 'false')
      return mnemonic
    } catch (err) {
      const message = (err as Error).message || 'No se pudo crear la billetera.'
      setError(message)
      throw new Error(message)
    } finally {
      setLoading(false)
    }
  }, [syncAddressAndBalance])

  const restoreWallet = useCallback(async (mnemonic: string) => {
    setLoading(true)
    setError(null)
    try {
      await xolosWalletService.restoreFromMnemonic(mnemonic)
      await syncAddressAndBalance()
      setInitialized(true)
      setBackupVerifiedState(false)
      localStorage.setItem(BACKUP_KEY, 'false')
    } catch (err) {
      const message = (err as Error).message || 'No se pudo restaurar la billetera.'
      setError(message)
      throw new Error(message)
    } finally {
      setLoading(false)
    }
  }, [syncAddressAndBalance])

  const loadExistingWallet = useCallback(
    async (password: string) => {
      setLoading(true)
      setError(null)
      try {
        await xolosWalletService.loadFromStorage(password)
        await syncAddressAndBalance()
        setInitialized(true)
        setBackupVerifiedState(localStorage.getItem(BACKUP_KEY) === 'true')
      } catch (err) {
        const message = (err as Error).message || 'No se pudo cargar la billetera guardada.'
        setError(message)
        throw new Error(message)
      } finally {
        setLoading(false)
      }
    },
    [syncAddressAndBalance]
  )

  const encryptAndStore = useCallback(
    (password: string) => {
      try {
        xolosWalletService.encryptAndStoreMnemonic(password)
        setBackupVerifiedState(true)
        localStorage.setItem(BACKUP_KEY, 'true')
      } catch (e) {
        console.error(e)
        setError('No pudimos acceder a tu seed para cifrarla. Vuelve a iniciar el proceso de onboarding y respaldo.')
      }
    },
    []
  )

  const sendRMZ = useCallback(
    async (to: string, amount: number) => {
      if (!initialized || !backupVerified) {
        throw new Error('La billetera no está lista: termina el onboarding y el respaldo de la seed.')
      }
      setLoading(true)
      setError(null)
      try {
        const txid = await xolosWalletService.sendRMZ(to, amount)
        await syncAddressAndBalance()
        return txid
      } catch (err) {
        const message = (err as Error).message || 'No se pudo enviar RMZ.'
        setError(message)
        throw new Error(message)
      } finally {
        setLoading(false)
      }
    },
    [backupVerified, initialized, syncAddressAndBalance]
  )

  const getMnemonic = useCallback(() => xolosWalletService.getMnemonic(), [])

  const value = useMemo(
    () => ({
      address,
      balance,
      loading,
      error,
      initialized,
      backupVerified,
      createNewWallet,
      restoreWallet,
      loadExistingWallet,
      encryptAndStore,
      refreshBalances,
      sendRMZ,
      getMnemonic,
      setBackupVerified: setBackupVerifiedState
    }),
    [
      address,
      balance,
      loading,
      error,
      initialized,
      backupVerified,
      createNewWallet,
      restoreWallet,
      loadExistingWallet,
      encryptAndStore,
      refreshBalances,
      sendRMZ,
      getMnemonic
    ]
  )

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
}

export function useWallet(): WalletContextValue {
  const context = useContext(WalletContext)
  if (!context) {
    throw new Error('useWallet debe usarse dentro de WalletProvider')
  }
  return context
}
