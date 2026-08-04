import { Injectable } from '@nestjs/common';
import { AurigaMockProvider } from './auriga-mock.provider.js';
import type { ProvisionRequest } from './connectivity-provider.js';
import { TransatelProvider } from './transatel.provider.js';

@Injectable()
export class ConnectivityService {
  constructor(private readonly auriga: AurigaMockProvider, private readonly transatel: TransatelProvider) {}
  private selected() { return process.env.CONNECTIVITY_PROVIDER === 'transatel' ? this.transatel : this.auriga; }
  descriptor() { const provider = this.selected(); return { provider: provider.name, capabilities: provider.capabilities() }; }
  health() { return this.selected().health(); }
  provision(request: ProvisionRequest) { return this.selected().provision(request); }
  getUsage(subscriptionId: string) { return this.selected().getUsage(subscriptionId); }
  getEsimDetails(subscriptionId: string) { return this.selected().getEsimDetails(subscriptionId); }
}
