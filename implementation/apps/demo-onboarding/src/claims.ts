/**
 * What Banco Horizonte asks a PID for, and where each claim lands in the onboarding form.
 *
 * The paths are the PID Rulebook v1.1 SD-JWT VC claim names, and must equal the policy's
 * (`scripts/onboarding/bank-onboarding.json`); `tests/unit/demo-onboarding.test.ts` holds the two
 * together. There is no age claim, because the PID has none: the bank receives the date of birth,
 * which an account opening needs anyway, and works out majority from it here.
 */

export interface OnboardingField {
  /** The claim path, dotted, as the platform's result keys it. */
  readonly path: string;
  /** The i18n key of the form label. */
  readonly label: string;
}

export const FIELDS: readonly OnboardingField[] = [
  { path: "given_name", label: "fieldGivenName" },
  { path: "family_name", label: "fieldFamilyName" },
  { path: "birthdate", label: "fieldBirthdate" },
  { path: "nationalities", label: "fieldNationalities" },
  { path: "personal_administrative_number", label: "fieldDocument" },
  { path: "address.street_address", label: "fieldStreet" },
  { path: "address.postal_code", label: "fieldPostalCode" },
  { path: "address.locality", label: "fieldLocality" },
  { path: "address.country", label: "fieldCountry" },
];

export const REQUESTED_CLAIMS: readonly (readonly string[])[] = FIELDS.map((f) =>
  f.path.split("."),
);

/** A result keys a nested claim by its dotted path; read it nested too, in case it does not. */
const read = (claims: Readonly<Record<string, unknown>>, path: string): unknown => {
  if (path in claims) return claims[path];
  let at: unknown = claims;
  for (const segment of path.split(".")) {
    if (typeof at !== "object" || at === null) return undefined;
    at = (at as Record<string, unknown>)[segment];
  }
  return at;
};

const text = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    const parts = value.filter((v): v is string => typeof v === "string");
    return parts.length > 0 ? parts.join(", ") : undefined;
  }
  return undefined;
};

/** Whether a `YYYY-MM-DD` date of birth is at least 18 years before `today` (`YYYY-MM-DD`). */
export const isAdult = (birthdate: string, today: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthdate) || !/^\d{4}-\d{2}-\d{2}$/.test(today))
    return false;
  const limit = `${String(Number(today.slice(0, 4)) - 18).padStart(4, "0")}${today.slice(4)}`;
  return birthdate <= limit;
};

export interface OnboardingData {
  /** The form's verified values, in form order. Only the fields the policy asks for. */
  readonly fields: readonly { readonly path: string; readonly value: string }[];
  /** The bank's own rule, on the date of birth it received. */
  readonly adult: boolean;
}

/** The verified claims as the form shows them. Anything the policy did not ask for is dropped. */
export const toOnboardingData = (
  claims: Readonly<Record<string, unknown>>,
  today: string,
): OnboardingData => {
  const fields: { path: string; value: string }[] = [];
  for (const field of FIELDS) {
    const value = text(read(claims, field.path));
    if (value !== undefined) fields.push({ path: field.path, value });
  }
  const birthdate = text(read(claims, "birthdate"));
  return { fields, adult: birthdate !== undefined && isAdult(birthdate, today) };
};
