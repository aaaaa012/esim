import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { AurigaMockProvider } from './auriga-mock.provider.js';
import type { ProvisionRequest } from './connectivity-provider.js';
import { TransatelProvider } from './transatel.provider.js';

@Injectable()
export class ConnectivityService implements OnModuleInit {
  private readonly logger = new Logger(ConnectivityService.name);
  constructor(private readonly auriga: AurigaMockProvider, private readonly transatel: TransatelProvider) {}

  private selected() { return process.env.CONNECTIVITY_PROVIDER === 'transatel' ? this.transatel : this.auriga; }

  async onModuleInit() {
    // Transatel deprecated self-service webhook registration in February 2026.
    // Registration remains an explicit operations action for legacy tenants;
    // application startup must not depend on that control-plane endpoint.
    if (process.env.TRANSATEL_CATALOG_SYNC_ON_STARTUP === 'true') {
      try {
        const result = await this.transatel.syncCatalog();
        this.logger.log(`Transatel catalog sync on startup: ${result.synced} synced, ${result.skipped} skipped`);
      } catch (error) {
        this.logger.warn(
          `Transatel catalog sync failed at startup: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }
  }

  descriptor() { const provider = this.selected(); return { provider: provider.name, capabilities: provider.capabilities() }; }
  health() { return this.selected().health(); }
  transatelHealth() { return this.transatel.health(); }
  provision(request: ProvisionRequest) { return this.selected().provision(request); }
  getUsage(subscriptionId: string) { return this.selected().getUsage(subscriptionId); }
  getEsimDetails(subscriptionId: string) { return this.selected().getEsimDetails(subscriptionId); }
  suspend(subscriptionId: string, transactionReference: string) { return this.transatel.suspend(subscriptionId, transactionReference); }
  terminate(subscriptionId: string, transactionReference: string) { return this.transatel.terminate(subscriptionId, transactionReference); }
  syncCatalog() { return this.transatel.syncCatalog(); }
  catalogReport(cos?: string) { return this.transatel.catalogReport(cos); }
  checkEligibility(planId: string, msisdn: string) { return this.transatel.checkEligibility(planId, msisdn); }
  ensureWebhook() { return this.transatel.ensureWebhook(); }
  handleWebhook(payload: unknown) { return this.transatel.handleWebhook(payload); }
}
