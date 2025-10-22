import { Injectable } from '@angular/core';
import { Network } from '@capacitor/network';
import { Wallet } from 'ecash-wallet';
import { ChronikClient } from 'chronik-client';
import type { WalletInfo } from './cartera.service';
import {
  OfflineStorageService,
  StoredTransaction,
} from './offline-storage.service';
import { StorageService } from './storage.service';
import { WalletService } from './wallet.service';

const chronik: ChronikClient = new ChronikClient(['https://chronik.e.cash']);
const SATS_PER_XEC = 100;

type WalletSource =
  | Pick<WalletInfo, 'mnemonic' | 'address'>
  | { mnemonic: string; address?: string };

@Injectable({ providedIn: 'root' })
export class EnviarService {
  private isProcessingPending = false;

  constructor(
    private readonly offlineStorage: OfflineStorageService,
    private readonly storage: StorageService,
    private readonly walletService: WalletService,
  ) {
    if (typeof window !== 'undefined') {
      void this.storage
        .initDB()
        .catch((error) => console.error('IndexedDB init failed', error));
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        void this.processPendingTransactions();
      });
    }
  }

  async enviarTx(toAddress: string, amount: number): Promise<{
    success: boolean;
    txid?: string;
    error?: string;
  }> {
    try {
      const txid = await this.walletService.createAndBroadcastTx(toAddress, amount);
      return { success: true, txid };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Error enviando transacción:', error);
      return { success: false, error: message };
    }
  }

  async sendTransaction(fromWallet: WalletSource, toAddress: string, amount: number): Promise<string> {
    try {
      const mnemonic = fromWallet?.mnemonic?.trim();
      if (!mnemonic) {
        throw new Error('La cartera de origen debe incluir la frase mnemónica.');
      }
      const destination = toAddress?.trim();
      if (!destination) {
        throw new Error('La dirección de destino es obligatoria.');
      }
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error('El monto a enviar debe ser mayor que cero.');
      }

      const timestamp = new Date().toISOString();
      const { connected } = await this.getNetworkStatus();

      if (!connected) {
        const tx = {
          toAddress: destination,
          amount,
          txid: Date.now().toString(),
          pending: true,
        };
        this.storage.saveTx(tx);
        await this.queueTransaction(destination, amount, timestamp);
        console.log('Transacción guardada localmente (offline).');
        return `pending-offline-${tx.txid}`;
      }

      const wallet = await this.createWallet(mnemonic);

      const txid = await this.sendWithWallet(wallet, destination, amount);

      await this.offlineStorage.addTransaction({
        description: `Envío a ${destination}`,
        amount: -amount,
        date: timestamp,
        status: 'confirmed',
        txid,
        destination,
      });

      return txid;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.offlineStorage.addTransaction({
        description: `Error al enviar a ${toAddress}`,
        amount: -amount,
        date: new Date().toISOString(),
        status: 'failed',
        destination: toAddress,
        errorMessage: message,
      });
      throw new Error(`No se pudo enviar la transacción: ${message}`);
    }
  }

  private async getNetworkStatus(): Promise<{ connected: boolean }> {
    try {
      if (typeof Network?.getStatus === 'function') {
        return await Network.getStatus();
      }
    } catch (error) {
      console.warn('No se pudo obtener el estado de la red con Capacitor Network.', error);
    }

    const isConnected = typeof navigator === 'undefined' ? true : navigator.onLine;
    return { connected: isConnected };
  }

  async processPendingTransactions(): Promise<void> {
    if (this.isProcessingPending) {
      return;
    }

    this.isProcessingPending = true;

    try {
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        return;
      }

      const wallet = await this.offlineStorage.getWallet();
      if (!wallet?.mnemonic) {
        return;
      }

      const pendingTransactions = await this.offlineStorage.getPendingTransactions();
      if (!pendingTransactions.length) {
        return;
      }

      const walletInstance = await this.createWallet(wallet.mnemonic);

      for (const transaction of pendingTransactions) {
        await this.processPendingTransaction(walletInstance, transaction);
      }
    } finally {
      this.isProcessingPending = false;
    }
  }

  private async queueTransaction(destination: string, amount: number, date: string): Promise<StoredTransaction> {
    return this.offlineStorage.addTransaction({
      description: `Envío pendiente a ${destination}`,
      amount: -amount,
      date,
      status: 'pending',
      destination,
      payload: { destination, amount },
    });
  }

  private async processPendingTransaction(wallet: Wallet, transaction: StoredTransaction): Promise<void> {
    if (!transaction.id) {
      return;
    }

    if (!transaction.payload?.destination || !Number.isFinite(transaction.payload.amount)) {
      await this.offlineStorage.updateTransaction(transaction.id, {
        status: 'failed',
        errorMessage: 'Información incompleta para sincronizar la transacción.',
      });
      return;
    }

    try {
      const txid = await this.sendWithWallet(
        wallet,
        transaction.payload.destination,
        transaction.payload.amount,
      );

      await this.offlineStorage.updateTransaction(transaction.id, {
        status: 'confirmed',
        txid,
        date: new Date().toISOString(),
        payload: undefined,
        errorMessage: undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? 'Error desconocido al sincronizar.');
      await this.offlineStorage.updateTransaction(transaction.id, {
        status: 'failed',
        errorMessage: message,
      });
    }
  }

  private async createWallet(mnemonic: string): Promise<Wallet> {
    const normalizedMnemonic = this.normalizeMnemonic(mnemonic);
    return Wallet.fromMnemonic(normalizedMnemonic, chronik);
  }

  private normalizeMnemonic(mnemonic: string): string {
    return mnemonic
      .trim()
      .split(/\s+/u)
      .map((word) => word.toLowerCase())
      .join(' ');
  }

  private xecToSats(amount: number): number {
    if (!Number.isFinite(amount)) {
      throw new Error('El monto proporcionado no es válido.');
    }

    return Math.round(amount * SATS_PER_XEC);
  }

  private async sendWithWallet(wallet: Wallet, destination: string, amountXec: number): Promise<string> {
    const satsAmount = this.xecToSats(amountXec);

    if (satsAmount <= 0) {
      throw new Error('El monto convertido a satoshis debe ser mayor que cero.');
    }

    const tx = await wallet.createTx({
      to: destination,
      amount: satsAmount,
    });

    const broadcastResult = await wallet.broadcastTx(tx);

    if (typeof broadcastResult === 'string' && broadcastResult) {
      return broadcastResult;
    }

    const txid = this.extractTxid(broadcastResult);

    if (!txid) {
      throw new Error('No se pudo obtener el identificador de la transacción.');
    }

    return txid;
  }

  private extractTxid(result: unknown): string | null {
    if (typeof result === 'string') {
      return result;
    }

    if (result && typeof result === 'object') {
      const record = result as Record<string, unknown>;
      const possibleKeys = ['txid', 'txId', 'id'];
      for (const key of possibleKeys) {
        const value = record[key];
        if (typeof value === 'string' && value) {
          return value;
        }
      }
    }

    return null;
  }
}
