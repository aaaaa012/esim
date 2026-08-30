/**
 * Destination countries that must never have sellable eSIM packages.
 *
 * The store sells travel eSIMs for travellers leaving Nepal (the home market),
 * so Nepal itself is not a valid destination for a travel plan and must never
 * appear in the catalogue, partner APIs, admin imports, or provider syncs.
 */
export const RESTRICTED_PLAN_COUNTRY_CODES: readonly string[] = ["NP"] as const;

/** True when the given ISO country code is a restricted plan destination. */
export function isRestrictedPlanCountry(
  countryCode: string | null | undefined,
): boolean {
  if (!countryCode) return false;
  return RESTRICTED_PLAN_COUNTRY_CODES.includes(countryCode.toUpperCase());
}
