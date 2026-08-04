export type ProvisionRequest = { orderId: string; planId: string; eid: string; traveler: { firstName: string; surname: string; email: string; mobile: string; city: string; countryOfResidence: string } };
export type ProvisionResult = { providerSubscriptionId: string; status: 'COMPLETED' | 'DELAYED'; qrPayload?: string; smDpAddress?: string };
export type ConnectivityCapabilities = { catalogSync: boolean; provisioning: boolean; usage: boolean; esimDetails: boolean; topUp: boolean; callbacks: boolean };
export interface ConnectivityProvider {
  readonly name: string;
  health(): Promise<{ ok: boolean }>;
  capabilities(): ConnectivityCapabilities;
  provision(request: ProvisionRequest): Promise<ProvisionResult>;
  getUsage(subscriptionId: string): Promise<{ usedMb: number; totalMb: number }>;
  getEsimDetails(subscriptionId: string): Promise<{ subscriptionId: string; status: string; smDpAddress?: string }>;
}
