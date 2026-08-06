/**
 * MSISDN (mobile number) normalization and matching.
 *
 * A number is canonicalized to bare local digits so that equivalent forms such
 * as `+977 9841 234 567`, `0097719841234567` and `9841234567` all collapse to
 * the same value and can be compared safely. The exact accepted input format is
 * intentionally generic: an explicit international prefix (`+` or `00`) is
 * followed by the E.164 country calling code, which is stripped so the local
 * number remains.
 */

const MIN_LOCAL_DIGITS = 5;

/** E.164 country calling codes keyed by dial code. Longest prefixes win. */
export const E164_CALLING_CODES: Record<string, string> = {
  '1242': 'Bahamas',
  '1246': 'Barbados',
  '1264': 'Anguilla',
  '1268': 'Antigua and Barbuda',
  '1284': 'British Virgin Islands',
  '1340': 'US Virgin Islands',
  '1345': 'Cayman Islands',
  '1441': 'Bermuda',
  '1473': 'Grenada',
  '1649': 'Turks and Caicos Islands',
  '1664': 'Montserrat',
  '1671': 'Guam',
  '1684': 'American Samoa',
  '1721': 'Sint Maarten',
  '1758': 'Saint Lucia',
  '1767': 'Dominica',
  '1784': 'Saint Vincent and the Grenadines',
  '1787': 'Puerto Rico',
  '1809': 'Dominican Republic',
  '1829': 'Dominican Republic',
  '1849': 'Dominican Republic',
  '1868': 'Trinidad and Tobago',
  '1869': 'Saint Kitts and Nevis',
  '1876': 'Jamaica',
  '1939': 'Puerto Rico',
  '590': 'Guadeloupe',
  '599': 'Caribbean Netherlands',
  '800': 'International',
  '850': 'North Korea',
  '852': 'Hong Kong',
  '853': 'Macau',
  '855': 'Cambodia',
  '856': 'Laos',
  '880': 'Bangladesh',
  '886': 'Taiwan',
  '960': 'Maldives',
  '961': 'Lebanon',
  '962': 'Jordan',
  '963': 'Syria',
  '964': 'Iraq',
  '965': 'Kuwait',
  '966': 'Saudi Arabia',
  '967': 'Yemen',
  '968': 'Oman',
  '970': 'Palestine',
  '971': 'United Arab Emirates',
  '972': 'Israel',
  '973': 'Bahrain',
  '974': 'Qatar',
  '975': 'Bhutan',
  '976': 'Mongolia',
  '977': 'Nepal',
  '992': 'Tajikistan',
  '993': 'Turkmenistan',
  '994': 'Azerbaijan',
  '995': 'Georgia',
  '996': 'Kyrgyzstan',
  '998': 'Uzbekistan',
  '1': 'United States/Canada',
  '20': 'Egypt',
  '211': 'South Sudan',
  '212': 'Morocco',
  '213': 'Algeria',
  '216': 'Tunisia',
  '218': 'Libya',
  '220': 'Gambia',
  '221': 'Senegal',
  '222': 'Mauritania',
  '223': 'Mali',
  '224': 'Guinea',
  '225': 'Ivory Coast',
  '226': 'Burkina Faso',
  '227': 'Niger',
  '228': 'Togo',
  '229': 'Benin',
  '230': 'Mauritius',
  '231': 'Liberia',
  '232': 'Sierra Leone',
  '233': 'Ghana',
  '234': 'Nigeria',
  '235': 'Chad',
  '236': 'Central African Republic',
  '237': 'Cameroon',
  '238': 'Cape Verde',
  '239': 'Sao Tome and Principe',
  '240': 'Equatorial Guinea',
  '241': 'Gabon',
  '242': 'Republic of the Congo',
  '243': 'Democratic Republic of the Congo',
  '244': 'Angola',
  '245': 'Guinea-Bissau',
  '248': 'Seychelles',
  '249': 'Sudan',
  '250': 'Rwanda',
  '251': 'Ethiopia',
  '252': 'Somalia',
  '253': 'Djibouti',
  '254': 'Kenya',
  '255': 'Tanzania',
  '256': 'Uganda',
  '257': 'Burundi',
  '258': 'Mozambique',
  '260': 'Zambia',
  '261': 'Madagascar',
  '262': 'Reunion',
  '263': 'Zimbabwe',
  '264': 'Namibia',
  '265': 'Malawi',
  '266': 'Lesotho',
  '267': 'Botswana',
  '268': 'Eswatini',
  '269': 'Comoros',
  '27': 'South Africa',
  '290': 'Saint Helena',
  '291': 'Eritrea',
  '297': 'Aruba',
  '298': 'Faroe Islands',
  '299': 'Greenland',
  '30': 'Greece',
  '31': 'Netherlands',
  '32': 'Belgium',
  '33': 'France',
  '34': 'Spain',
  '350': 'Gibraltar',
  '351': 'Portugal',
  '352': 'Luxembourg',
  '353': 'Ireland',
  '354': 'Iceland',
  '355': 'Albania',
  '356': 'Malta',
  '357': 'Cyprus',
  '358': 'Finland',
  '359': 'Bulgaria',
  '36': 'Hungary',
  '370': 'Lithuania',
  '371': 'Latvia',
  '372': 'Estonia',
  '373': 'Moldova',
  '374': 'Armenia',
  '375': 'Belarus',
  '376': 'Andorra',
  '377': 'Monaco',
  '378': 'San Marino',
  '380': 'Ukraine',
  '381': 'Serbia',
  '382': 'Montenegro',
  '383': 'Kosovo',
  '385': 'Croatia',
  '386': 'Slovenia',
  '387': 'Bosnia and Herzegovina',
  '389': 'North Macedonia',
  '39': 'Italy',
  '40': 'Romania',
  '41': 'Switzerland',
  '420': 'Czech Republic',
  '421': 'Slovakia',
  '423': 'Liechtenstein',
  '43': 'Austria',
  '44': 'United Kingdom',
  '45': 'Denmark',
  '46': 'Sweden',
  '47': 'Norway',
  '48': 'Poland',
  '49': 'Germany',
  '500': 'Falkland Islands',
  '501': 'Belize',
  '502': 'Guatemala',
  '503': 'El Salvador',
  '504': 'Honduras',
  '505': 'Nicaragua',
  '506': 'Costa Rica',
  '507': 'Panama',
  '508': 'Saint Pierre and Miquelon',
  '509': 'Haiti',
  '51': 'Peru',
  '52': 'Mexico',
  '53': 'Cuba',
  '54': 'Argentina',
  '55': 'Brazil',
  '56': 'Chile',
  '57': 'Colombia',
  '58': 'Venezuela',
  '591': 'Bolivia',
  '592': 'Guyana',
  '593': 'Ecuador',
  '594': 'French Guiana',
  '595': 'Paraguay',
  '596': 'Martinique',
  '597': 'Suriname',
  '598': 'Uruguay',
  '60': 'Malaysia',
  '61': 'Australia',
  '62': 'Indonesia',
  '63': 'Philippines',
  '64': 'New Zealand',
  '65': 'Singapore',
  '66': 'Thailand',
  '670': 'Timor-Leste',
  '672': 'Antarctica',
  '673': 'Brunei',
  '674': 'Nauru',
  '675': 'Papua New Guinea',
  '676': 'Tonga',
  '677': 'Solomon Islands',
  '678': 'Vanuatu',
  '679': 'Fiji',
  '680': 'Palau',
  '681': 'Wallis and Futuna',
  '682': 'Cook Islands',
  '683': 'Niue',
  '685': 'Samoa',
  '686': 'Kiribati',
  '687': 'New Caledonia',
  '688': 'Tuvalu',
  '689': 'French Polynesia',
  '690': 'Tokelau',
  '691': 'Micronesia',
  '692': 'Marshall Islands',
  '7': 'Russia/Kazakhstan',
  '81': 'Japan',
  '82': 'South Korea',
  '84': 'Vietnam',
  '86': 'China',
  '90': 'Turkey',
  '91': 'India',
  '92': 'Pakistan',
  '93': 'Afghanistan',
  '94': 'Sri Lanka',
  '95': 'Myanmar',
  '98': 'Iran',
};

const SORTED_CODES = Object.keys(E164_CALLING_CODES).sort((a, b) => b.length - a.length);

/** Longest-matching E.164 calling code for a digit string, if one is present. */
export function callingCodeFor(digits: string): string | undefined {
  for (const code of SORTED_CODES) {
    if (digits.startsWith(code) && digits.length - code.length >= MIN_LOCAL_DIGITS) {
      return code;
    }
  }
  return undefined;
}

/**
 * Canonicalizes a subscriber number to bare local digits.
 *
 * - Strips spaces, dashes, dots, parentheses and leading `+`.
 * - Treats a leading `00` as the international prefix.
 * - When the input was explicitly international, strips the E.164 country
 *   calling code so `+9779841234567` matches `9841234567`.
 */
export function normalizeMsisdn(input: string): string {
  const cleaned = String(input ?? '').replace(/[\s\-()./]/g, '');
  let digits = cleaned;
  let international = false;
  if (digits.startsWith('+')) {
    international = true;
    digits = digits.slice(1);
  } else if (digits.startsWith('00')) {
    international = true;
    digits = digits.slice(2);
  }
  digits = digits.replace(/\D/g, '');
  if (international && digits) {
    const code = callingCodeFor(digits);
    if (code) digits = digits.slice(code.length);
  }
  return digits;
}

/**
 * A set of plausible stored spellings of the same number, used to narrow a
 * database search for a mobile column before exact normalized matching in JS.
 */
export function msisdnVariants(input: string): Set<string> {
  const variants = new Set<string>();
  const raw = String(input ?? '').trim();
  if (raw) variants.add(raw);
  const stripped = raw.replace(/[\s\-()./]/g, '');
  if (stripped) variants.add(stripped);
  const withoutPlus = stripped.startsWith('+') ? stripped.slice(1) : stripped.startsWith('00') ? stripped.slice(2) : stripped;
  if (withoutPlus) variants.add(withoutPlus);
  const normalized = normalizeMsisdn(input);
  if (normalized) {
    variants.add(normalized);
    variants.add(`+${normalized}`);
    variants.add(`00${normalized}`);
  }
  return variants;
}
