import { Component, OnInit, Optional } from '@angular/core';
import { FormBuilder, FormGroup, Validators } from '@angular/forms';

import { BleService } from '../../services/ble.service';
import { EnviarService } from '../../services/enviar.service';
import { WalletService } from '../../services/wallet.service';

@Component({
  selector: 'app-wallet',
  templateUrl: './wallet.page.html',
  styleUrls: ['./wallet.page.scss'],
})
export class WalletPage implements OnInit {
  wallet: any = null;
  address = '';
  balanceLabel = '--';
  showQr = false;
  qrImageSrc: string | null = null;
  sending = false;
  isLoading = false;
  errorMessage = '';
  successMessage = '';
  sendForm: FormGroup;

  constructor(
    private readonly walletService: WalletService,
    private readonly enviarService: EnviarService,
    formBuilder: FormBuilder,
    @Optional() private readonly bleService?: BleService,
  ) {
    this.sendForm = formBuilder.group({
      toAddr: ['', Validators.required],
      amount: [null, [Validators.required, Validators.min(0.01)]],
    });
  }

  async ngOnInit(): Promise<void> {
    await this.initWallet();
  }

  async initWallet(): Promise<void> {
    this.isLoading = true;
    this.errorMessage = '';

    try {
      const mnemonic = this.getStoredMnemonic();
      if (!mnemonic) {
        this.errorMessage = 'No hay semilla guardada.';
        return;
      }

      this.wallet = await this.walletService.loadFromMnemonic(mnemonic);
      this.address = await this.walletService.getAddress();
      await this.refreshBalance();
      await this.ensureQrCode();
    } catch (error) {
      console.error('Error al inicializar la cartera.', error);
      this.errorMessage = 'Error al inicializar la cartera.';
    } finally {
      this.isLoading = false;
    }
  }

  async refreshBalance(): Promise<void> {
    if (!this.address) {
      this.balanceLabel = '--';
      return;
    }

    try {
      const balance = await this.walletService.getBalance();
      this.balanceLabel = `${balance.toFixed(2)} XEC`;
    } catch (error) {
      console.error('No se pudo obtener el saldo.', error);
      this.balanceLabel = 'Saldo no disponible';
    }
  }

  toggleQr(): void {
    this.showQr = !this.showQr;

    if (!this.showQr) {
      this.qrImageSrc = null;
      return;
    }

    void this.ensureQrCode();
  }

  async onSubmit(): Promise<void> {
    if (this.sendForm.invalid || !this.address) {
      this.sendForm.markAllAsTouched();
      return;
    }

    this.sending = true;
    this.successMessage = '';
    this.errorMessage = '';

    const toAddr = String(this.sendForm.value.toAddr ?? '').trim();
    const amount = Number(this.sendForm.value.amount);

    if (!toAddr) {
      this.errorMessage = 'La dirección de destino es obligatoria.';
      this.sending = false;
      return;
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      this.errorMessage = 'El monto debe ser mayor que cero.';
      this.sending = false;
      return;
    }

    try {
      const result = await this.enviarService.enviarTx(toAddr, amount);
      if (result.success) {
        this.successMessage = `Transacción enviada ✅ TXID: ${result.txid}`;
        await this.refreshBalance();
        this.sendForm.reset();
      } else {
        this.errorMessage = result.error ?? 'No se pudo enviar la transacción.';
      }
    } catch (error) {
      console.error('Error al enviar transacción.', error);
      this.errorMessage = 'Error al enviar transacción.';
    } finally {
      this.sending = false;
    }
  }

  get bleStatus(): string | null {
    if (!this.bleService) {
      return null;
    }

    const device = this.bleService.connectedDevice;
    if (device) {
      const name = device.name || device.deviceId || 'Dispositivo BLE';
      return `Conectado a ${name}`;
    }

    return 'Sin conexión BLE';
  }

  private async ensureQrCode(): Promise<void> {
    if (!this.address) {
      this.qrImageSrc = null;
      return;
    }

    this.qrImageSrc = this.buildQrUrl(this.address);
  }

  private buildQrUrl(address: string): string {
    const encoded = encodeURIComponent(address.trim());
    return `https://quickchart.io/qr?text=${encoded}&size=256&margin=1`;
  }

  private getStoredMnemonic(): string | null {
    if (typeof window === 'undefined' || !window.localStorage) {
      return null;
    }

    const mnemonic = window.localStorage.getItem('rmz_mnemonic');
    if (mnemonic) {
      return mnemonic;
    }

    const walletInfo = window.localStorage.getItem('rmz_wallet');
    if (!walletInfo) {
      return null;
    }

    try {
      const parsed = JSON.parse(walletInfo) as { mnemonic?: string };
      return typeof parsed.mnemonic === 'string' ? parsed.mnemonic : null;
    } catch (error) {
      console.warn('No se pudo leer la cartera almacenada.', error);
      return null;
    }
  }
}
