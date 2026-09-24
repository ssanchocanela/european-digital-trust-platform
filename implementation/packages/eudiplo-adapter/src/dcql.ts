import type { TrustAnchorSource, TrustDomain, VerificationPlan } from "@edtp/domain";
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
  readonly trusted_authorities?: readonly DcqlTrustedAuthority[];
}

/**
 * The engine's `etsi_tl` trusted-authority entry, naming lists **the engine holds**.
 *
 * Not the OpenID4VP wire form — the engine rewrites it before the request leaves, and the
 * deployment strips it from the request altogether (`VP_REMOVE_TA`, `interop-findings.md` A31).
 * What it does is make the engine validate the presented credential's signer against those lists.
 * Without it the engine returns verified **without evaluating issuer trust at all** (A30).
 */
export interface DcqlTrustedAuthority {
  readonly type: "etsi_tl";
  readonly values: readonly { readonly trustListId: string }[];
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
export const buildDcqlQuery = (plan: {
  // Narrowed from `VerificationPlan` to the two fields this actually reads, so an **eligibility**
  // presentation — which carries policy content but no Relying Party context — can use the same
  // builder. A second DCQL builder for the issuance side is how the two would drift, and a drift
  // here is a request that no longer matches the published policy. `interop-findings.md` A22.
  readonly credentialRequirement: VerificationPlan["credentialRequirement"];
  readonly requestedClaims: VerificationPlan["requestedClaims"];
  readonly anchorSources: readonly TrustAnchorSource[];
  /** Anchor source `ref` → id of the engine-held list built from it. */
  readonly issuerTrustLists: Readonly<Record<string, string>>;
}): DcqlQuery => {
  const requirement = plan.credentialRequirement;
  const claims: readonly DcqlClaim[] = plan.requestedClaims.map((c) => ({ path: c.path }));
  const trusted_authorities = issuerTrustedAuthorities(
    plan.anchorSources,
    plan.issuerTrustLists,
  );
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
        trusted_authorities,
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
      trusted_authorities,
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
 * The ARF trust domains whose anchors decide whether an **attestation's issuer** is trusted.
 *
 * Access- and registration-certificate provider anchors are a different question — who may ask,
 * not who signed what was presented — and are never used here (`interop-findings.md` C1).
 */
const ISSUER_TRUST_DOMAINS: ReadonlySet<TrustDomain> = new Set([
  "PID_PROVIDER",
  "QEAA_PROVIDER",
  "PUB_EAA_PROVIDER",
  "EAA_PROVIDER",
]);

/**
 * Compiles a policy's anchor sources into the engine's trusted authorities, **failing closed**.
 *
 * A policy with no issuer anchor source is refused rather than compiled, because the engine's
 * behaviour for a credential with no trusted authorities is to skip issuer trust and report the
 * presentation verified (`interop-findings.md` A30). A request built that way would accept an
 * attestation signed by anyone holding a key, and the platform would call the result `VERIFIED`.
 *
 * Every source must be one this deployment has provisioned into the engine. The mapping is
 * configuration, not a lookup by URL, because the engine cannot consume the notified lists by URL
 * (A30) — a list is fetched, its signature checked against a pinned signer, and loaded into the
 * engine by `scripts/load-issuer-trust-list.mjs`.
 */
export const issuerTrustedAuthorities = (
  anchorSources: readonly TrustAnchorSource[],
  issuerTrustLists: Readonly<Record<string, string>>,
): readonly DcqlTrustedAuthority[] => {
  const sources = anchorSources.filter((source) => ISSUER_TRUST_DOMAINS.has(source.domain));
  if (sources.length === 0) {
    throw PlatformError.validation(
      "trust_anchor_sources_missing",
      "The policy names no trust anchor source for attestation issuers, so the presentation " +
        "could not be checked against any trusted issuer. Add one to the policy's trust policy.",
    );
  }
  const values = sources.map((source) => {
    if (source.kind !== "ETSI_TS_119_602_LOTE") {
      throw PlatformError.validation(
        "trust_anchor_source_kind_unsupported",
        `Trust anchor sources of kind ${source.kind} are not supported yet; use an ETSI TS 119 602 list.`,
      );
    }
    const trustListId = issuerTrustLists[source.ref];
    if (!trustListId) {
      throw PlatformError.validation(
        "trust_anchor_source_not_provisioned",
        `The trust anchor source ${source.ref} is not loaded in this deployment.`,
      );
    }
    return { trustListId };
  });
  return [{ type: "etsi_tl", values }];
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
