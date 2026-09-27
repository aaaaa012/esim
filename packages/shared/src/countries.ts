/**
 * Destination countries that must never have sellable eSIM packages.
 *
 * The store sells travel eSIMs for travellers leaving Nepal (the home market),
 * so Nepal itself is not a valid destination for a travel plan and must never
 * appear in the catalogue, partner APIs, admin imports, or provider syncs.
 */
export const RESTRICTED_PLAN_COUNTRY_CODES: readonly string[] = ["NP"] as const;

// ISO 3166-1 alpha-2 codes. Keep identity inputs constrained to assigned
// countries instead of accepting any arbitrary pair of letters (for example,
// `PO`, which is not Poland; Poland is `PL`).
const ISO_ALPHA2_COUNTRY_CODES = new Set(
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(
    " ",
  ),
);

export function isIsoAlpha2CountryCode(
  value: string | null | undefined,
): boolean {
  return Boolean(
    value && ISO_ALPHA2_COUNTRY_CODES.has(value.trim().toUpperCase()),
  );
}

/** True when the given ISO country code is a restricted plan destination. */
export function isRestrictedPlanCountry(
  countryCode: string | null | undefined,
): boolean {
  if (!countryCode) return false;
  return RESTRICTED_PLAN_COUNTRY_CODES.includes(countryCode.toUpperCase());
}
