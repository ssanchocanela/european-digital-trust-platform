import type { VerificationPlan } from "@edtp/domain";
import { PlatformError } from "@edtp/shared";

/**
 * DCQL construction.
 *
 * This is the **only** place in the platform where a protocol query is built. The
 * domain's `VerificationPlan` carries credential types, claim paths and trust
 * constraints; turning those into a Digital Credentials Query Language document is the
 * adapter's job — ADR 0002 Decision 2.
 *
 * Claim paths pass through unchanged. They are already OpenID4VP claims path pointers
 * (TS5 `Claim.path`, OpenID4VP §6.3 with §7.1 for `dc+sd-jwt` and §7.2 for `mso_mdoc`),
 * which is exactly what DCQL expects — one of the reasons ADR 0005 Decision 1c models
 * requested claims as paths rather than as flat attribute names.
 */

export interface DcqlClaim {
  readonly path: readonly (string | number | null)[];
}

export interface DcqlCredential {
  readonly id: string;
  readonly format: "dc+sd-jwt" | "mso_mdoc";
  readonly meta: Record<string, unknown>;
  readonly claims: readonly DcqlClaim[];
}

export interface DcqlQuery {
  readonly credentials: readonly DcqlCredential[];
}

/**
 * A stable, non-identifying credential id for the query.
 *
 * The engine echoes this id back in its per-credential outcome, so it must be stable
 * for a given plan. It must not carry the transaction id or anything user-specific: the
 * id travels to the wallet, and a unique value per transaction would be a correlation
 * handle. Deriving it from the credential type keeps it stable and non-identifying.
 */
export const dcqlCredentialId = (credentialType: string): string => {
  const slug = credentialType
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug.length > 0 ? slug : "credential";
};

/**
 * Builds the DCQL query for a plan.
 *
 * V0 emits exactly one credential, because a V0 policy carries exactly one credential
 * requirement. When a plan accepts both formats, one DCQL credential entry is emitted
 * per format so the wallet may satisfy the request with either.
 */
export const buildDcqlQuery = (plan: VerificationPlan): DcqlQuery => {
  const requirement = plan.credentialRequirement;
  const claims: readonly DcqlClaim[] = plan.requestedClaims.map((c) => ({ path: c.path }));
  const credentials: DcqlCredential[] = [];

  for (const format of requirement.acceptedFormats) {
    if (format === "dc+sd-jwt") {
      const vctValues = requirement.vctValues ?? [];
      if (vctValues.length === 0) {
        throw PlatformError.internal(
          "plan_missing_vct_values",
          "The plan accepts dc+sd-jwt but carries no vct values.",
        );
      }
      credentials.push({
        id: `${dcqlCredentialId(requirement.credentialType)}-sdjwt`,
        format: "dc+sd-jwt",
        // OpenID4VP Annex B.3.5 for the SD-JWT VC meta parameter.
        meta: { vct_values: [...vctValues] },
        claims,
      });
      continue;
    }

    const doctype = requirement.doctype;
    if (!doctype) {
      throw PlatformError.internal(
        "plan_missing_doctype",
        "The plan accepts mso_mdoc but carries no document type.",
      );
    }
    credentials.push({
      id: `${dcqlCredentialId(requirement.credentialType)}-mdoc`,
      format: "mso_mdoc",
      // The engine reads `meta.doctype_value`; its v7.3.0 release fixed this field name
      // to match the schema it accepts. OpenID4VP Annex B.2.3 defines the parameter.
      meta: { doctype_value: doctype },
      claims,
    });
  }

  if (credentials.length === 0) {
    throw PlatformError.internal(
      "plan_has_no_formats",
      "The plan accepts no credential format, so no query can be built.",
    );
  }

  return { credentials };
};

/**
 * Maps the platform status-check mode to the engine's.
 *
 * The engine's `strict` is fail-closed: if a status list cannot be fetched or
 * validated, verification fails. V0 uses it, because `AS-AP-07-023` (`VCR_13`) requires
 * a documented risk analysis before skipping revocation checking and V0 has performed
 * none.
 */
export const toEngineStatusCheckMode = (
  mode: "STRICT" | "BEST_EFFORT" | "DISABLED",
): "strict" | "best_effort" | "disabled" => {
  switch (mode) {
    case "STRICT":
      return "strict";
    case "BEST_EFFORT":
      return "best_effort";
    case "DISABLED":
      return "disabled";
  }
};
