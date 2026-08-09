import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { ConnectivityProvider, ProvisionRequest } from './connectivity-provider.js';

@Injectable()
export class AurigaMockProvider implements ConnectivityProvider {
  readonly name = 'AURIGA_MOCK';
  async health() { return { ok: true }; }
  capabilities() { return { catalogSync: true, provisioning: true, usage: true, esimDetails: true, topUp: false, callbacks: true }; }
  async provision(request: ProvisionRequest) {
    const suffix = createHash('sha256').update(request.orderId).digest('hex').slice(0, 16);
    return { providerSubscriptionId: `auriga-${suffix}`, status: 'COMPLETED' as const, qrPayload: `LPA:1$mock.visacompass.com$${suffix}`, smDpAddress: 'mock.visacompass.com' };
  }
  async getUsage() { return { usedMb: 0, totalMb: 5120 }; }
  async getEsimDetails(subscriptionId: string) { return { subscriptionId, status: 'ACTIVE', smDpAddress: 'mock.visacompass.com' }; }
}
