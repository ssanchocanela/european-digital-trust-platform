/**
 * The recorded fallback: what the page plays when the presenter switches the wallet and the verifier
 * out — a dropped network, a phone that will not scan.
 *
 * It is a **recording of nothing real**. The person is fictitious and so is every value; no wallet
 * presented them and no verifier checked them. The page says so for as long as the fallback is on
 * (`CLAUDE.md` §8: a simulated success is never shown as a real one), and the technical panel marks
 * each of its events as recorded.
 */

/** The statuses the page shows, and how long after the start each appears, in milliseconds. */
export const RECORDED_STATUSES: readonly {
  readonly afterMs: number;
  readonly status: string;
}[] = [
  { afterMs: 0, status: "AWAITING_WALLET" },
  { afterMs: 3_500, status: "PRESENTATION_RECEIVED" },
  { afterMs: 4_500, status: "VERIFYING" },
  { afterMs: 5_500, status: "VERIFIED" },
];

/** Laura Martínez Soler: a fictitious person. The document number is not a valid one. */
export const RECORDED_CLAIMS: Readonly<Record<string, unknown>> = {
  given_name: "Laura",
  family_name: "Martínez Soler",
  birthdate: "1992-03-14",
  nationalities: ["ES"],
  personal_administrative_number: "00000000T-FICTICIO",
  "address.street_address": "Carrer de l'Exemple 123, 2n 1a",
  "address.postal_code": "08000",
  "address.locality": "Barcelona",
  "address.country": "ES",
};

/** The recorded income certificate: the same fictitious person, and a fictitious salary. */
export const RECORDED_INCOME_CLAIMS: Readonly<Record<string, unknown>> = {
  net_monthly_income: 2450,
  contract_type: "permanent",
  employed_since: "2019-03-01",
  given_name: "Laura",
  family_name: "Martínez Soler",
  birthdate: "1992-03-14",
};
