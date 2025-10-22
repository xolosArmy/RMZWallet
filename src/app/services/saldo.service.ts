import { Injectable } from '@angular/core';
import { ChronikClient } from 'chronik-client';

@Injectable({ providedIn: 'root' })
export class SaldoService {
  private readonly chronik = new ChronikClient(['https://chronik.e.cash']);

  async getBalance(address: string): Promise<number> {
    const { utxos = [] } = await this.chronik.address(address).utxos();

    const totalSats = utxos.reduce((sum: number, u: any) => {
      const v = typeof u.sats === 'bigint' ? Number(u.sats) : (u.sats ?? 0);
      return sum + v;
    }, 0);

    return totalSats / 100; // 100 sats = 1 XEC
  }

  formatBalance(xec: number | null | undefined): string {
    if (typeof xec !== 'number' || isNaN(xec)) return '0.00';
    return xec.toFixed(2);
  }
}
