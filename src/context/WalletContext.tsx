import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { xolosWalletService } from '../services/XolosWalletService'
import type { WalletBalance, WalletRescanOptions } from '../services/XolosWalletService'
import { getChronik } from '../services/ChronikClient'
import { computeNetworkFeeSats, MIN_NETWORK_FEE_SATS, TONALLI_SERVICE_FEE_SATS, XEC_DUST_SATS } from '../config/xecFees'
import { parseTokenAmount } from '../utils/tokenFormat'
import { WalletContext } from './walletContext'

const BACKUP_KEY = 'xoloswallet_backup_verified'

const P2PKH_INPUT_BYTES = 148
const P2PKH_OUTPUT_BYTES = 34
const TX_OVERHEAD_BYTES = 10
const MAX_FEE_ITERATIONS = 5
const OP_RETURN_PREFIX_HEX = '6d02'

type SpendableUtxo = {
  sats: bigint
  outpoint: { txid: string; outIdx: number }
  token?: unknown
}

type XecPlan = {
  selectedUtxos: SpendableUtxo[]
  changeSats: bigint
  includeChange: boolean
  networkFeeSats: number
  txBytes: number
  totalCostSats: number
}

const estimateTxBytes = (inputsCount: number, p2pkhOutputsCount: number, opReturnOutputBytes = 0) =>
  TX_OVERHEAD_BYTES + inputsCount * P2PKH_INPUT_BYTES + p2pkhOutputsCount * P2PKH_OUTPUT_BYTES + opReturnOutputBytes

const selectUtxos = (utxos: SpendableUtxo[], requiredSats: bigint) => {
  const selected: SpendableUtxo[] = []
  let accumulated = 0n

  for (const utxo of utxos) {
    selected.push(utxo)
    accumulated += utxo.sats
    if (accumulated >= requiredSats) {
      break
    }
  }

  return { selected, accumulated }
}

const calcPushdataBytes = (length: number) => {
  if (length <= 75) return 1 + length
  if (length <= 255) return 2 + length
  if (length <= 65535) return 3 + length
  return 5 + length
}

const calcOpReturnOutputBytes = (message: string, prefixHex: string) => {
  if (!message.trim()) return 0
  const messageBytes = new TextEncoder().encode(message).length
  const prefixBytes = Math.ceil(prefixHex.length / 2)
  const payloadBytes = prefixBytes + messageBytes
  const scriptBytes = 1 + calcPushdataBytes(payloadBytes)
  const scriptLenBytes = scriptBytes < 253 ? 1 : scriptBytes <= 0xffff ? 3 : 5
  return 8 + scriptLenBytes + scriptBytes
}

const buildXecPlan = (amountSats: number, utxos: SpendableUtxo[], opReturnOutputBytes = 0): XecPlan => {
  const amountSatBig = BigInt(amountSats)
  const tonalliFeeBig = BigInt(TONALLI_SERVICE_FEE_SATS)
  const dustBig = BigInt(XEC_DUST_SATS)

  let feeSats = MIN_NETWORK_FEE_SATS
  let selected: SpendableUtxo[] = []
  let accumulated = 0n
  let changeSats = 0n
  let includeChange = false
  let txBytes = 0

  for (let i = 0; i < MAX_FEE_ITERATIONS; i += 1) {
    const requiredSats = amountSatBig + tonalliFeeBig + BigInt(feeSats)
    ;({ selected, accumulated } = selectUtxos(utxos, requiredSats))

    if (accumulated < requiredSats) {
      break
    }

    changeSats = accumulated - requiredSats
    includeChange = changeSats >= dustBig
    const p2pkhOutputs = includeChange ? 3 : 2
    txBytes = estimateTxBytes(selected.length, p2pkhOutputs, opReturnOutputBytes)

    const nextFeeSats = computeNetworkFeeSats(txBytes)
    if (nextFeeSats === feeSats) {
      break
    }
    feeSats = nextFeeSats
  }

  const requiredFinal = amountSatBig + tonalliFeeBig + BigInt(feeSats)
  ;({ selected, accumulated } = selectUtxos(utxos, requiredFinal))

  if (accumulated < requiredFinal) {
    throw new Error('No se encontraron suficientes UTXOs para construir la transacción.')
  }

  changeSats = accumulated - requiredFinal
  includeChange = changeSats >= dustBig
  const p2pkhOutputsFinal = includeChange ? 3 : 2
  txBytes = estimateTxBytes(selected.length, p2pkhOutputsFinal, opReturnOutputBytes)

  const finalFeeSats = computeNetworkFeeSats(txBytes)
  if (finalFeeSats !== feeSats) {
    feeSats = finalFeeSats
    const requiredRetry = amountSatBig + tonalliFeeBig + BigInt(feeSats)
    ;({ selected, accumulated } = selectUtxos(utxos, requiredRetry))
    if (accumulated < requiredRetry) {
      throw new Error('No se encontraron suficientes UTXOs para construir la transacción.')
    }
    changeSats = accumulated - requiredRetry
    includeChange = changeSats >= dustBig
    const p2pkhOutputsRetry = includeChange ? 3 : 2
    txBytes = estimateTxBytes(selected.length, p2pkhOutputsRetry, opReturnOutputBytes)
  }

  const outputsTotal = amountSatBig + tonalliFeeBig + (includeChange ? changeSats : 0n)
  const actualFee = accumulated - outputsTotal
  const networkFeeSats = Number(actualFee)
  const totalCostSats = Number(amountSatBig + tonalliFeeBig + actualFee)

  return {
    selectedUtxos: selected,
    changeSats,
    includeChange,
    networkFeeSats,
    txBytes,
    totalCostSats
  }
}

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

  const rescanWallet = useCallback(
    async (options?: WalletRescanOptions) => {
      if (!initialized) {
        throw new Error('La billetera no está lista.')
      }
      setLoading(true)
      setError(null)
      try {
        const balances = await xolosWalletService.rescanWallet(options)
        setAddress(xolosWalletService.getAddress())
        setBalance(balances)
      } catch (err) {
        const message = (err as Error).message || 'No se pudo re-escanear la billetera.'
        setError(message)
        throw new Error(message)
      } finally {
        setLoading(false)
      }
    },
    [initialized]
  )

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
    async (to: string, amount: string) => {
      if (!initialized || !backupVerified) {
        throw new Error('La billetera no está lista: termina el onboarding y el respaldo de la seed.')
      }
      setLoading(true)
      setError(null)
      try {
        const decimals = balance?.rmzDecimals ?? (await xolosWalletService.getRmzDecimals())
        const atoms = parseTokenAmount(amount, decimals)
        const txid = await xolosWalletService.sendRMZ(to, atoms)
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
    [backupVerified, initialized, syncAddressAndBalance, balance]
  )

  const estimateXecSend = useCallback(
    async (amountInSats: number, message = '') => {
      if (!initialized) {
        throw new Error('La billetera no está lista.')
      }
      if (!amountInSats || amountInSats <= 0) {
        throw new Error('El monto debe ser mayor a cero.')
      }

      const walletKeyInfo = xolosWalletService.getKeyInfo()
      const changeAddress = walletKeyInfo.address ?? walletKeyInfo.xecAddress
      if (!changeAddress) {
        throw new Error('No se encontró la dirección de la billetera.')
      }

      const opReturnOutputBytes = message.trim()
        ? calcOpReturnOutputBytes(message, OP_RETURN_PREFIX_HEX)
        : 0

      const chronik = getChronik()
      const scriptUtxos = await chronik.address(changeAddress).utxos()
      const spendableUtxos = scriptUtxos.utxos
        .filter((utxo: SpendableUtxo) => !utxo.token)
        .sort((a: SpendableUtxo, b: SpendableUtxo) => (a.sats > b.sats ? -1 : 1))

      const plan = buildXecPlan(amountInSats, spendableUtxos, opReturnOutputBytes)
      return {
        networkFeeSats: plan.networkFeeSats,
        totalCostSats: plan.totalCostSats
      }
    },
    [initialized]
  )

  const sendXEC = useCallback(
    async (to: string, amountInSats: number, message?: string) => {
      if (!initialized || !backupVerified) {
        throw new Error('La billetera no está lista: termina el onboarding y el respaldo de la seed.')
      }
      setLoading(true)
      setError(null)
      try {
        const txid = await xolosWalletService.sendXEC(to, amountInSats, message || '')
        await syncAddressAndBalance()
        return txid
      } catch (err) {
        const messageText = (err as Error).message || 'No se pudo enviar XEC.'
        setError(messageText)
        throw new Error(messageText)
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
      rescanWallet,
      sendRMZ,
      sendXEC,
      estimateXecSend,
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
      rescanWallet,
      sendRMZ,
      sendXEC,
      estimateXecSend,
      getMnemonic,
      unlockEncryptedWallet
    ]
  )

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
}
