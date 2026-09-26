import type { TravelerInput } from "./schemas.js";

export const PASSPORT_IDENTITY_FIELDS = [
  "firstName",
  "middleName",
  "surname",
  "dateOfBirth",
  "nationality",
  "passportNumber",
  "passportExpiryDate",
] as const;

const TRAVELER_FIELDS = [
  "title",
  ...PASSPORT_IDENTITY_FIELDS,
  "city",
  "countryOfResidence",
  "employerOrBusinessName",
  "email",
  "mobile",
  "pointOfSaleCode",
] as const;

type TravelerValues = Partial<Record<(typeof TRAVELER_FIELDS)[number], string | null | undefined>>;

const normalized = (field: (typeof TRAVELER_FIELDS)[number], value: string | null | undefined) => {
  const trimmed = (value ?? "").trim();
  return ["nationality", "countryOfResidence", "email"].includes(field)
    ? trimmed.toUpperCase()
    : trimmed;
};

export function travelerChangeKind(
  previous: TravelerValues | null | undefined,
  submitted: TravelerValues | TravelerInput,
): "new" | "unchanged" | "contact" | "identity" {
  if (!previous) return "new";
  if (PASSPORT_IDENTITY_FIELDS.some((field) =>
    normalized(field, previous[field]) !== normalized(field, submitted[field]),
  )) return "identity";
  if (TRAVELER_FIELDS.some((field) =>
    normalized(field, previous[field]) !== normalized(field, submitted[field]),
  )) return "contact";
  return "unchanged";
}
