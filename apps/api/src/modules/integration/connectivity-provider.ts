export type ProvisionRequest = { orderId: string; planId: string; eid: string; traveler: { firstName: string; surname: string; email: string; mobile: string; city: string; countryOfResidence: string } };
export type ProvisionResult = { providerSubscriptionId: string; status: 'COMPLETED' | 'DELAYED'; qrPayload?: string; smDpAddress?: string };
export type EsimDetailsResult = { subscriptionId: string; status: string; smDpAddress?: string; qrPayload?: string };
export type EligibilityResult = { allowed: boolean; errorKey?: string; errorMessage?: string };
export type ConnectivityCapabilities = { catalogSync: boolean; provisioning: boolean; usage: boolean; esimDetails: boolean; topUp: boolean; callbacks: boolean };

/**
 * Normalized provider lifecycle event emitted by the connectivity provider.
 * Raw provider webhook payloads are mapped into this shape before they ever
 * reach order/inventory services (see docs/ADR-002-provider-adapters.md).
 */
export type ProviderWebhookEvent = {
  eventType: string;
  orderId?: string;
  iccid?: string;
  subscriptionId?: string;
  externalReference?: string;
  status?: 'PRELOADED' | 'ACTIVATED' | 'EXPIRED' | 'TERMINATED' | 'CANCELED' | 'OTHER';
  activatedAt?: string;
  expiresAt?: string;
  qrPayload?: string;
};

export type ProviderWebhookResult = { handled: boolean; event?: ProviderWebhookEvent; reason?: string };
export type CatalogSyncResult = { synced: number; skipped: number };

/**
 * One normalized row of the Transatel catalog, shaped exactly like the
 * upload columns accepted by AdminService.importPlansFromTabular so a
 * generated report can be re-uploaded without transformation.
 */
export type CatalogExportRow = {
  countryiso2: string;
  countryname: string;
  name: string;
  providerplanid: string;
  dataallowance: string;
  validitydays: number;
  costprice: number;
  sellingprice: number;
  currency: string;
  coveragecountries: string;
  status: string;
};

export type CatalogExportResult = { rows: CatalogExportRow[]; skipped: string[] };

export interface ConnectivityProvider {
  readonly name: string;
  health(): Promise<{ ok: boolean }>;
  capabilities(): ConnectivityCapabilities;
  provision(request: ProvisionRequest): Promise<ProvisionResult>;
  getUsage(subscriptionId: string): Promise<{ usedMb: number; totalMb: number }>;
  getEsimDetails(subscriptionId: string): Promise<EsimDetailsResult>;
  syncCatalog?(): Promise<CatalogSyncResult>;
  checkEligibility?(planId: string, msisdn: string): Promise<EligibilityResult>;
  handleWebhook?(payload: unknown): Promise<ProviderWebhookResult>;
}
