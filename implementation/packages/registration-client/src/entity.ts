import { z } from "zod";

/**
 * The data a registration session needs about the legal entity, validated before anything is
 * sent.
 *
 * ## Why validate at all, given the service validates too
 *
 * Because the service has no idempotency key and no route that amends a half-built registration
 * (`docs/interop-findings.md` C9). A field it rejects at step nine leaves eight entities behind
 * that cannot be edited away, and the login that created them can only be spent once per
 * presentation. So every check that can happen before the first call must happen before the first
 * call.
 *
 * The shapes here come from the service's own OpenAPI document at `/apispec_1.json`, not from its
 * `/guide` page, whose example bodies omit fields the document declares as required.
 */

/** A localised string, as the service spells it: `lang` plus `content`. */
const multiLang = z.object({
  lang: z.string().min(2).max(8),
  content: z.string().min(1),
});

/**
 * The `type` enum is closed in the OpenAPI document, so a wrong value is caught here rather than
 * by a 400 halfway through the chain.
 */
export const IDENTIFIER_TYPES = [
  "http://data.europa.eu/eudi/id/EORI-No",
  "http://data.europa.eu/eudi/id/LEI",
  "http://data.europa.eu/eudi/id/EUID",
  "http://data.europa.eu/eudi/id/VATIN",
  "http://data.europa.eu/eudi/id/TIN",
  "http://data.europa.eu/eudi/id/Excise",
] as const;

export const POLICY_TYPES = [
  "http://data.europa.eu/eudi/policy/trust-service-practice-statement",
  "http://data.europa.eu/eudi/policy/terms-and-conditions",
  "http://data.europa.eu/eudi/policy/privacy-statement",
  "http://data.europa.eu/eudi/policy/privacy-policy",
  "http://data.europa.eu/eudi/policy/registration-policy",
] as const;

/**
 * Entitlements are **URIs**, not the bare tokens an earlier draft of the session plan used. These
 * ten are the values observed in the live register on 12 September 2026; the list is not closed by
 * the OpenAPI document, so an unlisted value is a warning rather than an error.
 */
export const KNOWN_ENTITLEMENTS = [
  "http://data.europa.eu/eudi/entitlement/Service_Provider",
  "http://data.europa.eu/eudi/entitlement/Non_Q_EAA_Provider",
  "http://data.europa.eu/eudi/entitlement/PID_Provider",
  "http://data.europa.eu/eudi/entitlement/PUB_EAA_Provider",
  "http://data.europa.eu/eudi/entitlement/QEAA_Provider",
  "http://data.europa.eu/eudi/entitlement/QCert_for_ESig_Provider",
  "http://data.europa.eu/eudi/entitlement/QCert_for_ESeal_Provider",
  "http://data.europa.eu/eudi/entitlement/ESig_ESeal_Creation_Provider",
  "http://data.europa.eu/eudi/entitlement/rQSigCDs_Provider",
  "http://data.europa.eu/eudi/entitlement/rQSealCDs_Provider",
] as const;

const httpsUrl = z
  .string()
  .url()
  .refine((value) => value.startsWith("https://"), { message: "must be an https URL" });

export const entitySchema = z.object({
  law: z
    .array(
      z.object({
        legalBasis: z.array(z.string().min(1)).optional(),
        legislativeIdentifier: z.string().min(1),
      }),
    )
    .min(1),

  legalPerson: z.object({
    legalName: z.array(z.string().min(1)).min(1),
  }),

  identifiers: z
    .array(
      z.object({
        identifier: z.string().min(1),
        type: z.enum(IDENTIFIER_TYPES),
      }),
    )
    .min(1),

  legalEntity: z.object({
    country: z.string().length(2),
    email: z.array(z.string().email()).min(1),
    phone: z.array(z.string().min(1)).optional(),
    postalAddress: z.array(z.string().min(1)).optional(),
    infoURI: z.array(httpsUrl).optional(),
  }),

  policies: z.object({
    wrp: z.object({ policyURI: httpsUrl, type: z.enum(POLICY_TYPES) }),
    intendedUse: z.object({ policyURI: httpsUrl, type: z.enum(POLICY_TYPES) }),
  }),

  /**
   * `providerType` is the one field with no enum in the OpenAPI document and no example in the
   * live register, so it cannot be validated — only carried, and recorded once something is known
   * to work. See `docs/registration-session-plan.md` §3.1.
   */
  provider: z.object({ providerType: z.string().min(1) }),

  /**
   * `claims[].path` here is the **service's** JSON-path string, not the OpenID4VP claim-path array
   * of TS5 `Claim.path` that the platform uses. Conflating the two is the mistake CLAUDE.md §6
   * item 2 warns about, so this stays a plain string and the plan records that the correct spelling
   * for a PID attribute is unverified.
   */
  credentials: z
    .array(
      z.object({
        format: z.string().min(1),
        meta: z.record(z.unknown()),
        claims: z.array(z.object({ path: z.string().min(1) })).min(1),
      }),
    )
    .min(1),

  intendedUse: z.object({
    intendedUseIdentifier: z.string().min(1),
    /** Both timestamps are mandatory at the service: it wants an end date up front. */
    createdAt: z.string().datetime(),
    revokedAt: z.string().datetime(),
    purpose: z.array(multiLang).min(1),
  }),

  providedAttestations: z
    .array(z.object({ format: z.string().min(1), meta: z.string().min(1) }))
    .min(1),

  supervisoryAuthority: z.object({
    name: z.string().min(1),
    country: z.string().length(2),
    email: z.array(z.string().email()).optional(),
    phone: z.array(z.string().min(1)).optional(),
    formURI: z.array(httpsUrl).optional(),
  }),

  walletRelyingParty: z.object({
    tradeName: z.string().min(1),
    entitlements: z.array(z.string().url()).min(1),
    isPSB: z.boolean(),
    registryURI: httpsUrl,
    supportURI: z.array(httpsUrl).min(1),
    srvDescription: z.array(multiLang).min(1),
  }),
});

export type RegistrationEntity = z.infer<typeof entitySchema>;

/** The marker the example file uses for a value the operator must supply. */
const PLACEHOLDER = "CHANGE-ME";

export interface EntityProblem {
  readonly path: string;
  readonly message: string;
  readonly kind: "invalid" | "placeholder" | "warning";
}

/**
 * Walks the parsed object for leftover `CHANGE-ME` markers.
 *
 * Separate from the schema because a placeholder is structurally *valid* — it is a non-empty
 * string, and `https://CHANGE-ME.example.org/support` is a well-formed https URL. The schema
 * cannot see the problem, and the service would accept the value and register it, which is the
 * worst outcome: a registration naming a company that does not exist, unamendable.
 */
const findPlaceholders = (value: unknown, path = ""): EntityProblem[] => {
  if (typeof value === "string") {
    return value.includes(PLACEHOLDER)
      ? [
          {
            path: path || "(root)",
            message: `still contains ${PLACEHOLDER}`,
            kind: "placeholder",
          },
        ]
      : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findPlaceholders(item, `${path}[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) =>
      findPlaceholders(item, path ? `${path}.${key}` : key),
    );
  }
  return [];
};

export interface EntityCheck {
  readonly entity?: RegistrationEntity;
  readonly problems: readonly EntityProblem[];
  /** True only when nothing would stop a real run: no schema errors and no placeholders. */
  readonly runnable: boolean;
}

/**
 * Validates an entity file and reports everything wrong with it at once, rather than failing on
 * the first problem. An operator filling this in wants the whole list.
 */
export const checkEntity = (input: unknown): EntityCheck => {
  const parsed = entitySchema.safeParse(input);
  if (!parsed.success) {
    return {
      problems: parsed.error.issues.map((issue) => ({
        path: issue.path.join(".") || "(root)",
        message: issue.message,
        kind: "invalid" as const,
      })),
      runnable: false,
    };
  }

  const placeholders = findPlaceholders(parsed.data);

  // An unrecognised entitlement is a warning, not an error: the OpenAPI document does not close
  // the list, and refusing a value the register might well accept would be worse than saying so.
  const unknownEntitlements: EntityProblem[] = parsed.data.walletRelyingParty.entitlements
    .filter(
      (value) => !KNOWN_ENTITLEMENTS.includes(value as (typeof KNOWN_ENTITLEMENTS)[number]),
    )
    .map((value) => ({
      path: "walletRelyingParty.entitlements",
      message: `${value} was not among the ten entitlements seen in the live register`,
      kind: "warning" as const,
    }));

  return {
    entity: parsed.data,
    problems: [...placeholders, ...unknownEntitlements],
    runnable: placeholders.length === 0,
  };
};
