import { Injectable } from '@angular/core';
import { ChronikClient } from 'chronik-client';

import { addressToHash160 } from '../utils/address';

import { TxStorageService } from './tx-storage.service';
import { NotificationService } from './notification.service';
import { NotificationSettingsService } from './notification-settings.service';

type ChronikWsClient = ReturnType<ChronikClient['ws']>;

type ChronikWsMessage = {
  type?: string;
  txid?: string;
  tx?: { txid?: string };
};

@Injectable({
  providedIn: 'root',
})
export class ChronikService {
  private readonly chronik = new ChronikClient(['https://chronik.e.cash']);
  private readonly subscribedAddresses = new Set<string>();
  private wsClient?: ChronikWsClient;
  private wsReady!: Promise<void>;
  private resolveWsReady?: () => void;

  constructor(
    private readonly store: TxStorageService,
    private readonly notify: NotificationService,
    private readonly settingsService: NotificationSettingsService,
  ) {
    this.ensureWsClient();
  }

  async checkTxStatus(txid: string | undefined | null): Promise<void> {
    if (!txid) {
      return;
    }

    try {
      const res = await this.chronik.tx(txid);
      if (res && res.block) {
        console.log('✅ TX confirmada:', txid);
        this.store.updateStatusByTxid(txid, 'confirmed');
      } else {
        console.log('⏳ TX aún no confirmada:', txid);
        this.store.updateStatusByTxid(txid, 'broadcasted');
      }
    } catch (err: any) {
      if (err?.response?.status === 404) {
        console.log('🚫 TX aún no propagada:', txid);
      } else {
        console.error('Error verificando TX:', err);
      }
    }
  }

  async subscribeToAddress(address: string | undefined | null): Promise<void> {
    if (!address || this.subscribedAddresses.has(address)) {
      return;
    }

    this.subscribedAddresses.add(address);

    try {
      await this.ensureWsClient();
      await this.wsReady;
      const h160 = addressToHash160(address);
      await this.subscribeToChronikScript('p2pkh', h160);
    } catch (err) {
      console.error('❌ Error Chronik WS:', err);
    }
  }

  async syncAll(): Promise<void> {
    const txs = this.store.getAll();
    for (const tx of txs) {
      if (tx.txid && tx.status !== 'confirmed') {
        await this.checkTxStatus(tx.txid);
      }
    }
  }

  startAutoSync(intervalMs = 60000): void {
    setInterval(() => this.syncAll(), intervalMs);
  }

  private ensureWsClient(): ChronikWsClient {
    if (!this.wsClient) {
      this.prepareWsReady();
      this.wsClient = this.chronik.ws({
        onMessage: msg => this.handleWsMessage(msg),
        onReconnect: e => {
          console.warn('🔁 Reconexion Chronik', e);
          this.prepareWsReady();
        },
      });

      this.wsClient.onConnect = () => {
        void (async () => {
          console.log('🛰️ Conectado a Chronik WS');
          this.resolveWsReady?.();
          this.resolveWsReady = undefined;

          for (const address of this.subscribedAddresses) {
            try {
              const h160 = addressToHash160(address);
              await this.subscribeToChronikScript('p2pkh', h160);
            } catch (err) {
              console.error('❌ Error suscribiendo dirección Chronik:', err);
            }
          }
        })();
      };
    }

    return this.wsClient;
  }

  private async subscribeToChronikScript(scriptType: string, script: string): Promise<void> {
    if (!this.wsClient) {
      return;
    }

    const client = this.wsClient as unknown as {
      subscribe?: (type: string, id: string) => Promise<void>;
      subscribeToScript?: (type: string, id: string) => Promise<void>;
    };

    if (client.subscribe) {
      await client.subscribe(scriptType, script);
      return;
    }

    if (client.subscribeToScript) {
      await client.subscribeToScript(scriptType, script);
      return;
    }

    console.error('❌ Chronik WS client no soporta métodos de suscripción conocidos');
  }

  private prepareWsReady(): void {
    this.wsReady = new Promise(resolve => {
      this.resolveWsReady = resolve;
    });
  }

  private handleWsMessage(msg: ChronikWsMessage): void {
    if (!msg?.type) {
      return;
    }

    const txid = msg.txid || msg.tx?.txid;
    if (!txid) {
      return;
    }

    console.log('📦 TX actualizada vía WS:', txid, msg.type);

    const settings = this.settingsService.getSettings();

    if (msg.type === 'AddedToMempool' && settings.network) {
      this.notify.show('💸 Nueva TX detectada', 'Se ha recibido una transacción pendiente');
      this.store.updateStatusByTxid(txid, 'broadcasted');
    }

    if (msg.type === 'Confirmed' && settings.network) {
      this.notify.show('✅ Transacción confirmada', 'Una transacción ha sido incluida en bloque');
      this.store.updateStatusByTxid(txid, 'confirmed');
    }
  }
}
