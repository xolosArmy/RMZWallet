import type { ReactNode } from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { ALL_BIP143, P2PKHSignatory, Script, TxBuilder, fromHex } from 'ecash-lib'
import type { TxBuilderInput, TxBuilderOutput } from 'ecash-lib'
import { xolosWalletService } from '../services/XolosWalletService'
import type { WalletBalance } from '../services/XolosWalletService'
import { getChronik } from '../services/ChronikClient'
import {
  NETWORK_FEE_SATS,
  TONALLI_SERVICE_FEE_SATS,
  XEC_DUST_SATS,
  XEC_SATS_PER_XEC,
  XEC_TONALLI_TREASURY_ADDRESS
} from '../config/xecFees'

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
  sendXEC: (to: string, amount: number) => Promise<string>
  getMnemonic: () => string | null
  unlockEncryptedWallet: (password: string) => Promise<void>
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

  const unlockEncryptedWallet = useCallback(
    async (password: string) => {
      setError(null)
      try {
        await xolosWalletService.unlockEncryptedWallet(password)
      } catch (err) {
        const message = (err as Error).message || 'No se pudo desbloquear la seed cifrada.'
        setError(message)
        throw new Error(message)
      }
    },
    []
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

  const sendXEC = useCallback(
    async (to: string, amount: number) => {
      if (!initialized || !backupVerified) {
        throw new Error('La billetera no está lista: termina el onboarding y el respaldo de la seed.')
      }
      if (!amount || amount <= 0) {
        throw new Error('El monto debe ser mayor a cero.')
      }
      setLoading(true)
      setError(null)
      try {
        const amountSat = Math.round(amount * XEC_SATS_PER_XEC)
        const totalSat = amountSat + NETWORK_FEE_SATS + TONALLI_SERVICE_FEE_SATS
        const balanceInfo = await xolosWalletService.getBalances()
        if (balanceInfo.xec < totalSat) {
          throw new Error(
            `Saldo insuficiente: necesitas ${(totalSat / XEC_SATS_PER_XEC).toFixed(2)} XEC (incluye tarifa de red y servicio).`
          )
        }

        let destinationScript: Script
        try {
          destinationScript = Script.fromAddress(to)
        } catch {
          throw new Error('La dirección de destino no es válida.')
        }

        const keyInfo = xolosWalletService.getKeyInfo()
        const publicKey = fromHex(keyInfo.publicKeyHex)
        const privateKey = fromHex(keyInfo.privateKeyHex)
        const changeAddress = keyInfo.address
        const changeScript = Script.fromAddress(changeAddress)

        const chronik = getChronik()
        const scriptUtxos = await chronik.address(changeAddress).utxos()
        const spendableUtxos = scriptUtxos.utxos
          .filter((utxo) => !utxo.token)
          .sort((a, b) => (a.sats > b.sats ? -1 : 1))

        const inputs: TxBuilderInput[] = []
        let accumulated = 0n
        const requiredSat = BigInt(totalSat)

        for (const utxo of spendableUtxos) {
          inputs.push({
            input: {
              prevOut: utxo.outpoint,
              signData: {
                sats: utxo.sats,
                outputScript: changeScript
              }
            },
            signatory: P2PKHSignatory(privateKey, publicKey, ALL_BIP143)
          })
          accumulated += utxo.sats
          const change = accumulated - requiredSat
          if (change >= 0n && (change === 0n || change >= BigInt(XEC_DUST_SATS))) {
            break
          }
        }

        if (accumulated < requiredSat) {
          throw new Error('No se encontraron suficientes UTXOs para construir la transacción.')
        }

        const changeSat = accumulated - requiredSat
        if (changeSat > 0n && changeSat < BigInt(XEC_DUST_SATS)) {
          throw new Error('El cambio resultante es inferior al mínimo permitido. Intenta con otro monto.')
        }

        const outputs: TxBuilderOutput[] = [
          { sats: BigInt(amountSat), script: destinationScript },
          { sats: BigInt(TONALLI_SERVICE_FEE_SATS), script: Script.fromAddress(XEC_TONALLI_TREASURY_ADDRESS) }
        ]

        if (changeSat > 0n) {
          outputs.push({ sats: changeSat, script: changeScript })
        }

        const txBuilder = new TxBuilder({ inputs, outputs })
        const signedTx = txBuilder.sign()
        const rawTxHex = signedTx.toHex()
        const { txid } = await chronik.broadcastTx(rawTxHex)
        await syncAddressAndBalance()
        return txid
      } catch (err) {
        const message = (err as Error).message || 'No se pudo enviar XEC.'
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
      sendXEC,
      getMnemonic,
      unlockEncryptedWallet,
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
      sendXEC,
      getMnemonic,
      unlockEncryptedWallet
    ]
  )

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useWallet(): WalletContextValue {
  const context = useContext(WalletContext)
  if (!context) {
    throw new Error('useWallet debe usarse dentro de WalletProvider')
  }
  return context
}
