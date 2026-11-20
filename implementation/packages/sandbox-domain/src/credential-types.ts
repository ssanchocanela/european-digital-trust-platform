import { LANG_TAG_PATTERN, type LocalisedText, PlatformError } from "@edtp/shared";

/**
 * Credential types an EAA Provider defines in the sandbox (ADR 0023 §2). Pure.
 *
 * A type is a set of **flat** claims, each with a name, a display text and a value type. The sandbox
 * assigns its `vct`, under its own public address, so one predicate in a wallet build classifies every
 * type participants will ever define (ADR 0023 §6). Every version of a type keeps that `vct`; a version
 * is immutable once created.
 *
 * Every claim is issued selectively disclosable: that is the platform's rule for every type it issues
 * since `docs/interop-findings.md` A32, so the type has no per-claim choice.
 *
 * The definition holds names and shapes, never a value: the values are typed per issuance, and are
 * content (CLAUDE.md §5).
 */

/** The value types a sandbox claim may have: the platform's scalar types and `date`. */
export const SANDBOX_CLAIM_VALUE_TYPES = [
  "string",
  "number",
  "integer",
  "boolean",
  "date",
] as const;
export type SandboxClaimValueType = (typeof SANDBOX_CLAIM_VALUE_TYPES)[number];

export interface SandboxClaimDefinition {
  readonly name: string;
  readonly display: readonly LocalisedText[];
  readonly valueType: SandboxClaimValueType;
  readonly mandatory: boolean;
}

export interface SandboxCredentialTypeDefinition {
  readonly display: readonly LocalisedText[];
  readonly claims: readonly SandboxClaimDefinition[];
  /** How long an issued credential is valid. */
  readonly validitySeconds: number;
}

export const CREDENTIAL_TYPE_SLUG = /^[a-z][a-z0-9-]{2,39}$/;
const CLAIM_NAME = /^[a-z][a-z0-9_]{0,39}$/;
/** Names the SD-JWT VC or its JWT already uses, which a claim may not take over. */
const RESERVED_CLAIMS = new Set([
  "iss",
  "sub",
  "aud",
  "iat",
  "nbf",
  "exp",
  "jti",
  "cnf",
  "vct",
  "status",
  "_sd",
  "_sd_alg",
]);
export const CLAIMS_PER_TYPE = 30;
export const VALIDITY_SECONDS = { min: 3_600, max: 31_536_000 } as const;

const invalid = (path: string, code: string, message: string) =>
  PlatformError.validation(code, message, [{ path, code, message }]);

function validateTexts(path: string, texts: readonly LocalisedText[], max: number): void {
  if (!Array.isArray(texts) || texts.length === 0 || texts.length > 5) {
    throw invalid(path, "display_required", "Give one to five display texts.");
  }
  const langs = new Set<string>();
  for (const t of texts) {
    if (!LANG_TAG_PATTERN.test(t.lang)) {
      throw invalid(path, "display_lang_invalid", `"${t.lang}" is not a language tag.`);
    }
    if (langs.has(t.lang))
      throw invalid(path, "display_lang_repeated", "One text per language.");
    langs.add(t.lang);
    const value = t.value.trim();
    if (!value || value.length > max) {
      throw invalid(path, "display_length", `A display text is 1 to ${max} characters.`);
    }
  }
}

export function validateSandboxCredentialType(
  slug: string,
  definition: SandboxCredentialTypeDefinition,
): void {
  if (!CREDENTIAL_TYPE_SLUG.test(slug)) {
    throw invalid(
      "slug",
      "credential_type_slug_invalid",
      "A type name is 3 to 40 characters: lower-case letters, digits and hyphens, starting with a letter.",
    );
  }
  validateTexts("display", definition.display, 100);
  const claims = definition.claims;
  if (!Array.isArray(claims) || claims.length === 0 || claims.length > CLAIMS_PER_TYPE) {
    throw invalid("claims", "claims_count", `A type has 1 to ${CLAIMS_PER_TYPE} claims.`);
  }
  const names = new Set<string>();
  claims.forEach((c, i) => {
    const path = `claims[${i}]`;
    if (!CLAIM_NAME.test(c.name)) {
      throw invalid(
        `${path}.name`,
        "claim_name_invalid",
        "A claim name is lower-case letters, digits and underscores, starting with a letter, at most 40.",
      );
    }
    if (RESERVED_CLAIMS.has(c.name)) {
      throw invalid(
        `${path}.name`,
        "claim_name_reserved",
        `"${c.name}" is reserved by SD-JWT VC.`,
      );
    }
    if (names.has(c.name))
      throw invalid(`${path}.name`, "claim_name_repeated", "Repeated claim.");
    names.add(c.name);
    if (!SANDBOX_CLAIM_VALUE_TYPES.includes(c.valueType)) {
      throw invalid(`${path}.valueType`, "claim_value_type_invalid", "Unknown value type.");
    }
    validateTexts(`${path}.display`, c.display, 60);
  });
  if (
    !Number.isInteger(definition.validitySeconds) ||
    definition.validitySeconds < VALIDITY_SECONDS.min ||
    definition.validitySeconds > VALIDITY_SECONDS.max
  ) {
    throw invalid(
      "validitySeconds",
      "validity_out_of_range",
      "A credential is valid for one hour to one year.",
    );
  }
}

/** An organisation's register identifier as a path segment: `SB:ES-000001` → `sb-es-000001`. */
export const vctSegment = (localIdentifier: string): string =>
  localIdentifier.toLowerCase().replace(/[^a-z0-9-]+/g, "-");

/** The vct the sandbox assigns: under its own public address, never typed by a participant. */
export const sandboxVct = (publicBase: string, localIdentifier: string, slug: string): string =>
  `${publicBase.replace(/\/+$/, "")}/vct/${vctSegment(localIdentifier)}/${slug}`;

/** The prefix every sandbox EAA's vct starts with: what a wallet build classifies (ADR 0023 §6). */
export const sandboxVctPrefix = (publicBase: string): string =>
  `${publicBase.replace(/\/+$/, "")}/vct/`;

/**
 * SD-JWT VC Type Metadata for a version, served at its vct (draft-ietf-oauth-sd-jwt-vc, "Type
 * Metadata"). The pinned wallet does not read it (`TypeMetadataPolicy.NotUsed`, ADR 0023 Open 2); it is
 * there for wallets that do. Display comes from the issuer metadata either way.
 */
export function typeMetadata(
  vct: string,
  version: number,
  definition: SandboxCredentialTypeDefinition,
): Record<string, unknown> {
  const name = definition.display.find((d) => d.lang === "en") ?? definition.display[0];
  return {
    vct,
    name: name?.value,
    description: `EDTP sandbox TEST credential type, version ${version}. Not a real attestation.`,
    display: definition.display.map((d) => ({ locale: d.lang, name: d.value })),
    claims: definition.claims.map((c) => ({
      path: [c.name],
      display: c.display.map((d) => ({ locale: d.lang, label: d.value })),
      sd: "always",
    })),
  };
}

/**
 * Check the values typed for one issuance against the version's claims, and shape them for the
 * issuance service. The values are content: checked, passed on, and never kept here.
 */
export function shapeClaimValues(
  definition: SandboxCredentialTypeDefinition,
  values: Readonly<Record<string, unknown>>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const key of Object.keys(values)) {
    if (!definition.claims.some((c) => c.name === key)) {
      throw invalid(`values.${key}`, "claim_unknown", "This type has no such claim.");
    }
  }
  for (const c of definition.claims) {
    const raw = values[c.name];
    const empty = raw === undefined || raw === null || raw === "";
    if (empty) {
      if (c.mandatory)
        throw invalid(`values.${c.name}`, "claim_missing", "This claim is required.");
      continue;
    }
    const text = String(raw).trim();
    if (text.length > 200) throw invalid(`values.${c.name}`, "claim_too_long", "At most 200.");
    switch (c.valueType) {
      case "string":
        out[c.name] = text;
        break;
      case "date":
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(text) ||
          Number.isNaN(Date.parse(`${text}T00:00:00Z`))
        ) {
          throw invalid(`values.${c.name}`, "claim_not_a_date", "A date is YYYY-MM-DD.");
        }
        out[c.name] = text;
        break;
      case "boolean":
        if (raw !== true && raw !== false && text !== "true" && text !== "false") {
          throw invalid(`values.${c.name}`, "claim_not_a_boolean", "true or false.");
        }
        out[c.name] = raw === true || text === "true";
        break;
      case "integer":
      case "number": {
        const n = Number(text);
        if (!Number.isFinite(n) || (c.valueType === "integer" && !Number.isInteger(n))) {
          throw invalid(`values.${c.name}`, "claim_not_a_number", `Not a ${c.valueType}.`);
        }
        out[c.name] = n;
        break;
      }
    }
  }
  return out;
}
