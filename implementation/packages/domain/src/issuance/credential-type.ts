import type { LocalisedText } from "@edtp/shared";
import { PlatformError } from "@edtp/shared";
import type { CredentialFormat } from "../kernel/registration.js";

/**
 * A platform-owned credential type, and the Rulebook that governs it.
 *
 * ## Why a Rulebook reference is a first-class field
 *
 * ARF 3.0.0 §6.3.2.4 makes the **attestation Rulebook** the source of trust anchors for verifying
 * an attestation's signature: for a non-qualified EAA the verifier obtains the Attestation
 * Provider's trust anchors from the applicable Rulebook, and *optionally* from a list of trusted
 * providers published per ETSI TS 119 602 — a publication that is **not** bound by Topic 31, which
 * governs the notified lists (PID, PubEAA, WRPAC, WRPRC).
 *
 * That makes the Rulebook a piece of trust configuration, not documentation. A credential type
 * whose Rulebook is unknown has no defined trust anchors, so the platform refuses to publish a
 * policy version for it rather than issuing something unverifiable.
 *
 * See `docs/issuer-trust-model.md` gate (b), and `TrustAnchorPublication` in
 * `trust-anchor-publication.ts` for the optional ETSI TS 119 602 half.
 */
export interface AttestationRulebookRef {
  /**
   * Stable identifier of the Rulebook, as a URI.
   *
   * For an EUDI catalogue Rulebook this is its published identifier; for a platform-defined type
   * it is a URI the platform controls. It is **not** the `vct` — one Rulebook may govern several
   * attestation types, and the `vct` identifies the attestation, not the rules.
   */
  readonly identifier: string;
  /** Rulebook version, because trust anchors and attribute sets change between versions. */
  readonly version: string;
  /**
   * Where the Rulebook is published, when it is. Absent for a platform-defined type that has no
   * public Rulebook yet, which is the V0 case and is why this is optional rather than required.
   */
  readonly publicationUri?: string;
  /**
   * How an attestation of this type gets its trust anchors, per ARF §6.3.2.4.
   *
   * `RULEBOOK_ONLY` is the baseline: the anchors are whatever the Rulebook names.
   * `RULEBOOK_AND_PUBLISHED_LIST` additionally expects a list published per ETSI TS 119 602 —
   * the optional half of §6.3.2.4, and what `TrustAnchorPublication` produces.
   */
  readonly anchorSource: "RULEBOOK_ONLY" | "RULEBOOK_AND_PUBLISHED_LIST";
}

/** One claim the credential type carries. */
export interface CredentialClaimDefinition {
  /**
   * The claim path, as an OpenID4VP claims path pointer — the same shape the verification side
   * uses, deliberately, so a type issued here can be requested by a policy there without
   * translation.
   */
  readonly path: readonly string[];
  readonly display: readonly LocalisedText[];
  readonly mandatory: boolean;
  /** Shape only, never a value. Used to validate what the authentic source returns. */
  readonly valueType: "string" | "number" | "boolean" | "date";
}

export const STATUS_MECHANISMS = ["TOKEN_STATUS_LIST", "NONE"] as const;
export type StatusMechanism = (typeof STATUS_MECHANISMS)[number];

export interface CredentialType {
  readonly id: string;
  readonly tenantId: string;
  readonly attestationProviderId: string;
  /** Platform-facing name. Not shown to a User; the Wallet shows `display`. */
  readonly name: string;
  readonly format: CredentialFormat;
  /**
   * SD-JWT VC type identifier. Required when `format` is `dc+sd-jwt`.
   *
   * V0 issues exactly one SD-JWT VC non-qualified EAA, so this is the live path; `doctype` exists
   * for the mdoc case the domain must stay able to express.
   */
  readonly vct?: string;
  readonly doctype?: string;
  readonly rulebook: AttestationRulebookRef;
  readonly claims: readonly CredentialClaimDefinition[];
  readonly display: readonly LocalisedText[];
  readonly validitySeconds: number;
  readonly statusMechanism: StatusMechanism;
  /**
   * Whether the attestation is bound to a key the Wallet holds.
   *
   * `AS-AP-10-xxx` device binding is the norm; a type without it is a bearer attestation, which
   * is a deliberate and unusual choice, so it is explicit rather than defaulted.
   */
  readonly requiresKeyBinding: boolean;
  readonly createdAt: Date;
}

/**
 * Validates a credential type before it can be referenced by a policy.
 *
 * Refuses rather than repairs. Every rule here exists because the alternative is issuing an
 * attestation that cannot be verified, or whose Rulebook does not describe what it contains.
 */
export const validateCredentialType = (input: {
  readonly format: CredentialFormat;
  readonly vct?: string;
  readonly doctype?: string;
  readonly rulebook: AttestationRulebookRef;
  readonly claims: readonly CredentialClaimDefinition[];
  readonly display: readonly LocalisedText[];
  readonly validitySeconds: number;
  readonly statusMechanism: StatusMechanism;
}): void => {
  const details: { path: string; code: string; message: string }[] = [];

  if (input.format === "dc+sd-jwt" && !input.vct) {
    details.push({
      path: "vct",
      code: "vct_required",
      message: "An SD-JWT VC credential type must declare a vct.",
    });
  }
  if (input.format === "mso_mdoc" && !input.doctype) {
    details.push({
      path: "doctype",
      code: "doctype_required",
      message: "An mdoc credential type must declare a doctype.",
    });
  }
  if (input.format === "dc+sd-jwt" && input.doctype) {
    details.push({
      path: "doctype",
      code: "doctype_not_applicable",
      message: "An SD-JWT VC credential type must not declare a doctype.",
    });
  }

  // The Rulebook is trust configuration (ARF §6.3.2.4), so an unidentified one is a refusal.
  if (!input.rulebook.identifier.trim()) {
    details.push({
      path: "rulebook.identifier",
      code: "rulebook_required",
      message:
        "A credential type must name the Rulebook that governs it: ARF §6.3.2.4 makes the " +
        "Rulebook the source of trust anchors for verifying the attestation's signature.",
    });
  }
  if (!input.rulebook.version.trim()) {
    details.push({
      path: "rulebook.version",
      code: "rulebook_version_required",
      message: "A Rulebook reference must carry a version: anchors change between versions.",
    });
  }

  if (input.claims.length === 0) {
    details.push({
      path: "claims",
      code: "claims_required",
      message: "A credential type must define at least one claim.",
    });
  }
  for (const [i, claim] of input.claims.entries()) {
    if (claim.path.length === 0) {
      details.push({
        path: `claims[${i}].path`,
        code: "claim_path_empty",
        message: "A claim path must have at least one segment.",
      });
    }
    if (claim.display.length === 0) {
      details.push({
        path: `claims[${i}].display`,
        code: "claim_display_required",
        message:
          "Every claim needs display text: the Wallet shows it to the User when asking for " +
          "approval, so an undisplayable claim cannot be consented to meaningfully.",
      });
    }
  }

  if (input.display.length === 0) {
    details.push({
      path: "display",
      code: "display_required",
      message: "A credential type must carry display metadata for the Wallet.",
    });
  }
  if (input.validitySeconds <= 0) {
    details.push({
      path: "validitySeconds",
      code: "validity_invalid",
      message: "Validity must be a positive number of seconds.",
    });
  }

  const claimPaths = input.claims.map((c) => c.path.join("."));
  const duplicate = claimPaths.find((p, i) => claimPaths.indexOf(p) !== i);
  if (duplicate !== undefined) {
    details.push({
      path: "claims",
      code: "claim_path_duplicated",
      message: `Claim path '${duplicate}' is defined more than once.`,
    });
  }

  if (details.length > 0) {
    throw PlatformError.unprocessable(
      "credential_type_invalid",
      "The credential type is not valid.",
      details,
    );
  }
};

/** The claim paths a type declares, for validating an authentic source's response. */
export const declaredClaimPaths = (type: CredentialType): readonly string[] =>
  type.claims.map((c) => c.path.join("."));
