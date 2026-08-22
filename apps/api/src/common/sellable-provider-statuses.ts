/**
 * Provider eSIM profile states that are safe to sell.
 *
 * Per Transatel's SIM management lifecycle, "released" means the profile is
 * ready to be downloaded on a device — i.e. unsold stock. Reseller offers
 * (Ubigi eSIM Reseller, Service Provider Connect) deliver profiles already in
 * this state, so it must be treated as sellable alongside "available" and
 * "allocated". States that imply the profile reached a device (downloaded,
 * installed, enabled, disabled, deleted) remain unsafe.
 */
export const SELLABLE_PROVIDER_STATUSES: string[] = [
  "available",
  "allocated",
  "released",
  "AVAILABLE",
  "ALLOCATED",
  "RELEASED",
];

export function isSellableProviderStatus(status: string): boolean {
  return (SELLABLE_PROVIDER_STATUSES as readonly string[]).includes(
    status.toLowerCase(),
  );
}
