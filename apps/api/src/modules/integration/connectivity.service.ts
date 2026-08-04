import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { ProvisionRequest } from './connectivity-provider.js';
import { TransatelProvider } from './transatel.provider.js';

@Injectable()
export class ConnectivityService implements OnModuleInit {
  private readonly logger = new Logger(ConnectivityService.name);
  constructor(private readonly transatel: TransatelProvider) {}

  async onModuleInit() {
    if (process.env.TRANSATEL_WEBHOOK_TARGET_URL) {
      try {
        const result = await this.transatel.ensureWebhook();
        this.logger.log(
          `Transatel webhook ${result.registered ? 'registered' : 'verified'}: ${result.targetUrl} (${result.events.length} event type(s))`,
        );
      } catch (error) {
        this.logger.warn(
          `Transatel webhook registration failed at startup: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }
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

  descriptor() { const provider = this.transatel; return { provider: provider.name, capabilities: provider.capabilities() }; }
  health() { return this.transatel.health(); }
  provision(request: ProvisionRequest) { return this.transatel.provision(request); }
  getUsage(subscriptionId: string) { return this.transatel.getUsage(subscriptionId); }
  getEsimDetails(subscriptionId: string) { return this.transatel.getEsimDetails(subscriptionId); }
  syncCatalog() { return this.transatel.syncCatalog(); }
  checkEligibility(planId: string, msisdn: string) { return this.transatel.checkEligibility(planId, msisdn); }
  ensureWebhook() { return this.transatel.ensureWebhook(); }
  handleWebhook(payload: unknown) { return this.transatel.handleWebhook(payload); }
}
