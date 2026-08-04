import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { ConnectivityProvider, ProvisionRequest, ProvisionResult } from './connectivity-provider.js';

@Injectable()
export class TransatelProvider implements ConnectivityProvider {
  readonly name = 'TRANSATEL';
  capabilities() { return { catalogSync: true, provisioning: true, usage: true, esimDetails: true, topUp: true, callbacks: true }; }
  async health() { return { ok: Boolean(process.env.TRANSATEL_BASE_URL && process.env.TRANSATEL_CLIENT_ID && process.env.TRANSATEL_CLIENT_SECRET) }; }
  async provision(_request: ProvisionRequest): Promise<ProvisionResult> { throw this.notConfigured(); }
  async getUsage(_subscriptionId: string): Promise<{ usedMb:number; totalMb:number }> { throw this.notConfigured(); }
  async getEsimDetails(_subscriptionId: string): Promise<{ subscriptionId:string; status:string; smDpAddress?:string }> { throw this.notConfigured(); }
  private notConfigured() { return new ServiceUnavailableException('Transatel adapter requires certified API credentials and endpoint configuration'); }
}
