import { b64u, signCompactJws } from "./jws.js";
import type { Signer } from "./x509.js";

/**
 * The wallet-relying party registration certificate (WRPRC), `docs/sandbox/specification.md` §7.2,
 * and its defect variants (§5.2).
 *
 * ETSI TS 119 475 V1.2.1 §5.2: a JWT signed as JAdES B-B with `typ` `rc-wrp+jwt` (GEN-5.2.2-01) and
 * the whole chain in `x5c`; payload claims of Tables 7–10. The claim names are matched against what
 * EUDI Wallet Core 0.30.2 deserialises (`RegistrationCertificateDto`); the two agree on every name
 * used here. Where the ETSI text is inconsistent (`docs/interop-findings.md` D9) the Annex C example
 * and the wallet decide: `status.status_list.{idx, uri}`, claim paths as arrays, BCP 47 tags.
 *
 * `iat` is also put in the protected header: TS 119 182-1 V1.2.1 §5.1.11 makes it mandatory in a
 * JAdES signature made after 2025-07-15, and §5.2.1 forbids `sigT`.
 */

export const WRPRC_TYP = "rc-wrp+jwt";
/** ETSI TS 119 475 V1.2.1 OVR-6.1.3-01. */
export const WRPRC_POLICY_OID = "0.4.0.19475.3.1";
const ENTITLEMENT = "https://uri.etsi.org/19475/Entitlement/";
export const ENTITLEMENT_SERVICE_PROVIDER = `${ENTITLEMENT}Service_Provider`;
export const ENTITLEMENT_PID_PROVIDER = `${ENTITLEMENT}PID_Provider`;

export const WRPRC_VARIANTS = [
  "RC-00",
  "RC-01",
  "RC-02",
  "RC-03",
  "RC-04",
  "RC-05",
  "RC-06",
  "RC-07",
  "RC-08",
  "RC-09",
  "RC-10",
  "RC-11",
  "RC-12",
  "RC-13",
] as const;
export type WrprcVariant = (typeof WRPRC_VARIANTS)[number];

export const WRPRC_CHECKS = [
  "present",
  "format",
  "signature",
  "trusted_provider",
  "not_expired",
  "bound_to_access_certificate",
  "not_revoked",
  "status_present",
  "status_reachable",
  "covers_request",
  "entitlement",
  "provides_attestation",
  "validity_period",
] as const;
export type WrprcCheck = (typeof WRPRC_CHECKS)[number];

export interface WrprcVariantInfo {
  readonly title: string;
  readonly signer: "registrar" | "registrar-untrusted";
  readonly fails?: WrprcCheck;
  readonly requirement: string;
  /** The Wallet Core 0.30.2 `RegistrationFailureReason` a debug build would log, where one exists. */
  readonly walletCoreReason?: string;
  /** Whether a wallet looks at it only with *Check Registration Certificates* on. */
  readonly registrationCheck: boolean;
  /** Issuance-side defects are offered as take-away certificates only (specification J8, G-10). */
  readonly takeAwayOnly?: boolean;
  /** For which kind of certificate the variant makes sense. */
  readonly appliesTo: "service_provider" | "pid_provider" | "both";
}

export const WRPRC_VARIANT_INFO: Readonly<Record<WrprcVariant, WrprcVariantInfo>> = {
  "RC-00": {
    title: "Correct",
    signer: "registrar",
    requirement: "—",
    registrationCheck: true,
    appliesTo: "both",
  },
  "RC-01": {
    title: "Absent: the verifier sends none",
    signer: "registrar",
    fails: "present",
    requirement: "EW-DM-44-019 (RPRC_17)",
    walletCoreReason: "CERTIFICATE_ABSENT",
    registrationCheck: true,
    appliesTo: "service_provider",
  },
  "RC-02": {
    title: "Malformed: wrong typ",
    signer: "registrar",
    fails: "format",
    requirement: "EW-DM-44-019 (RPRC_17)",
    walletCoreReason: "MALFORMED",
    registrationCheck: true,
    appliesTo: "both",
  },
  "RC-03": {
    title: "Bad signature: payload altered after signing",
    signer: "registrar",
    fails: "signature",
    requirement: "EW-DM-44-019 (RPRC_17)",
    walletCoreReason: "SIGNATURE_INVALID",
    registrationCheck: true,
    appliesTo: "both",
  },
  "RC-04": {
    title: "Unknown provider",
    signer: "registrar-untrusted",
    fails: "trusted_provider",
    requirement: "EW-DM-44-005 (RPRC_02a)",
    walletCoreReason: "UNTRUSTED_PROVIDER",
    registrationCheck: true,
    appliesTo: "both",
  },
  "RC-05": {
    title: "Expired",
    signer: "registrar",
    fails: "not_expired",
    requirement: "EW-DM-44-019 (RPRC_17)",
    walletCoreReason: "EXPIRED",
    registrationCheck: true,
    appliesTo: "both",
  },
  "RC-06": {
    title: "Not bound to the access certificate",
    signer: "registrar",
    fails: "bound_to_access_certificate",
    requirement: "EW-DM-44-020 (RPRC_17a); issuance AS-AP-44-006 (RPRC_22b)",
    walletCoreReason: "NOT_BOUND_TO_REQUESTER",
    registrationCheck: true,
    appliesTo: "both",
  },
  "RC-07": {
    title: "Revoked",
    signer: "registrar",
    fails: "not_revoked",
    requirement: "No HLR — ARF §6.6.2.3; ETSI TS 119 475 REV-6.2.6.2-04",
    walletCoreReason: "REVOKED",
    registrationCheck: true,
    appliesTo: "both",
  },
  "RC-08": {
    title: "Over-asking: registers less than is requested",
    signer: "registrar",
    fails: "covers_request",
    requirement: "EW-DM-44-027 (RPRC_21)",
    registrationCheck: true,
    appliesTo: "service_provider",
  },
  "RC-09": {
    title: "No status",
    signer: "registrar",
    fails: "status_present",
    requirement: "ETSI TS 119 475 GEN-6.2.6.1-04",
    walletCoreReason: "STATUS_MISSING",
    registrationCheck: true,
    appliesTo: "both",
  },
  "RC-10": {
    title: "Status list unreachable",
    signer: "registrar",
    fails: "status_reachable",
    requirement: "ETSI TS 119 475 CSS-6.2.3.10-02",
    walletCoreReason: "REVOCATION_STATUS_UNKNOWN",
    registrationCheck: true,
    appliesTo: "both",
  },
  "RC-11": {
    title: "Wrong entitlement: a provider certificate without PID_Provider",
    signer: "registrar",
    fails: "entitlement",
    requirement: "No HLR — ARF §6.6.2.3 prose",
    walletCoreReason: "ENTITLEMENT_MISSING",
    registrationCheck: true,
    takeAwayOnly: true,
    appliesTo: "pid_provider",
  },
  "RC-12": {
    title: "Attestation type not registered",
    signer: "registrar",
    fails: "provides_attestation",
    requirement: "AS-AP-44-007 (RPRC_23)",
    registrationCheck: true,
    takeAwayOnly: true,
    appliesTo: "pid_provider",
  },
  "RC-13": {
    title: "Validity longer than 12 months",
    signer: "registrar",
    fails: "validity_period",
    requirement: "ETSI TS 119 475 GEN-5.2.4-08 (a provider-side rule, not a wallet check)",
    registrationCheck: true,
    appliesTo: "both",
  },
};

export interface LocalisedValue {
  readonly lang: string;
  readonly value: string;
}

export interface RegisteredCredential {
  readonly format: "dc+sd-jwt" | "mso_mdoc";
  /** `vct` values for SD-JWT VC, or the doctype for mdoc. */
  readonly types: readonly string[];
  /** OpenID4VP claim paths. */
  readonly claims: readonly (readonly (string | number | null)[])[];
}

export interface ProvidedAttestation {
  readonly format: "dc+sd-jwt" | "mso_mdoc";
  readonly type: string;
}

export interface WrprcInput {
  readonly variant: WrprcVariant;
  readonly kind: "service_provider" | "pid_provider";
  readonly organisation: {
    readonly legalName: string;
    readonly tradeName: string;
    readonly country: string;
    readonly localIdentifier: string;
    readonly isPublicSectorBody: boolean;
  };
  readonly service: {
    readonly identifier: string;
    readonly description: readonly LocalisedValue[];
  };
  /** A Service Provider certificate's intended use (Table 9). */
  readonly intendedUse?: {
    readonly identifier: string;
    readonly purpose: readonly LocalisedValue[];
    readonly credentials: readonly RegisteredCredential[];
  };
  /** A provider certificate's attestation types (Table 8). */
  readonly providesAttestations?: readonly ProvidedAttestation[];
  readonly urls: {
    readonly registry: string;
    readonly info: string;
    readonly support: string;
    readonly privacyPolicy: string;
    readonly certificatePolicy: string;
    /** Answers 503 always — the target of RC-10. */
    readonly unreachableStatus: string;
  };
  readonly status: { readonly index: number; readonly uri: string };
  readonly now: Date;
  readonly signer: Signer;
  /** The signer's chain, leaf first: the whole chain goes in `x5c` (GEN-5.2.2-01). */
  readonly chain: readonly Buffer[];
}

/** Never assigned: the sequence starts at 1. The target of RC-06. */
const unboundIdentifier = (localIdentifier: string) =>
  localIdentifier.replace(/-\d+$/, "-000000");
export const UNREGISTERED_CLAIM = "_edtp_rc08_not_requested";
export const UNREGISTERED_ATTESTATION_TYPE = "urn:edtp:sandbox:rc12:not-the-pid";

const DAY = 86_400_000;
export const WRPRC_VALIDITY_DAYS = 90;

const meta = (c: RegisteredCredential) =>
  c.format === "dc+sd-jwt" ? { vct_values: c.types } : { doctype_value: c.types[0] };

export function wrprcPayload(input: WrprcInput): Record<string, unknown> {
  const { variant, organisation, urls, now } = input;
  const iat = Math.floor(
    (variant === "RC-05" ? now.getTime() - 120 * DAY : now.getTime()) / 1000,
  );
  const exp =
    variant === "RC-05"
      ? Math.floor((now.getTime() - DAY) / 1000)
      : variant === "RC-13"
        ? iat + 400 * 86_400
        : iat + WRPRC_VALIDITY_DAYS * 86_400;
  const entitlements =
    input.kind === "service_provider" || variant === "RC-11"
      ? [ENTITLEMENT_SERVICE_PROVIDER]
      : [ENTITLEMENT_PID_PROVIDER];
  const payload: Record<string, unknown> = {
    name: organisation.tradeName,
    sub_ln: `TEST ${organisation.legalName}`,
    sub:
      variant === "RC-06"
        ? unboundIdentifier(organisation.localIdentifier)
        : organisation.localIdentifier,
    country: organisation.country,
    registry_uri: urls.registry,
    srv_description: input.service.description,
    entitlements,
    privacy_policy: urls.privacyPolicy,
    info_uri: urls.info,
    support_uri: urls.support,
    // No real authority is named: pointing a test certificate at a real DPA would be impersonation.
    supervisory_authority: {
      email: "mailto:supervisory-authority@sandbox.invalid",
      phone: "+000",
      uri: "https://sandbox.invalid/supervisory-authority-TEST",
    },
    policy_id: [WRPRC_POLICY_OID],
    certificate_policy: urls.certificatePolicy,
    public_body: organisation.isPublicSectorBody,
    iat,
    exp,
  };
  if (variant !== "RC-09") {
    payload.status = {
      status_list: {
        idx: input.status.index,
        uri: variant === "RC-10" ? urls.unreachableStatus : input.status.uri,
      },
    };
  }
  if (input.kind === "service_provider") {
    const use = input.intendedUse;
    if (!use) throw new Error("a Service Provider certificate needs an intended use");
    payload.intended_use_id = use.identifier;
    payload.purpose = use.purpose;
    payload.credentials = use.credentials.map((c) => ({
      format: c.format,
      meta: meta(c),
      claim: (variant === "RC-08" ? [[UNREGISTERED_CLAIM]] : c.claims).map((path) => ({
        path,
      })),
    }));
  } else {
    // EW-DM-44-009 (RPRC_05): no intended use in a provider certificate.
    const provided = input.providesAttestations ?? [];
    payload.provides_attestations = (
      variant === "RC-12"
        ? provided.map((p) => ({ ...p, type: UNREGISTERED_ATTESTATION_TYPE }))
        : provided
    ).map((p) => ({
      format: p.format,
      meta: p.format === "dc+sd-jwt" ? { vct_values: [p.type] } : { doctype_value: p.type },
    }));
  }
  return payload;
}

/** Sign a WRPRC, applying the variants that live in the envelope (RC-02, RC-03). */
export function issueWrprc(input: WrprcInput): string {
  if (input.variant === "RC-01")
    throw new Error("RC-01 is the absence of a certificate: nothing is issued");
  const payload = wrprcPayload(input);
  const header = {
    typ: input.variant === "RC-02" ? "rc+jwt" : WRPRC_TYP,
    x5c: input.chain.map((c) => c.toString("base64")),
    iat: payload.iat,
  };
  const compact = signCompactJws(header, payload, input.signer);
  if (input.variant !== "RC-03") return compact;
  // Alter the payload after signing: the signature no longer covers it.
  const [h, , s] = compact.split(".");
  return `${h}.${b64u(JSON.stringify({ ...payload, name: `${String(payload.name)} (altered)` }))}.${s}`;
}
