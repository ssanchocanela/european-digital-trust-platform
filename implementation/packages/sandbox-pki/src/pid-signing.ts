import type { KeyObject } from "node:crypto";
import { SANDBOX_POLICY_OID } from "./trust-domain.js";
import { TEST_NAME_PREFIX } from "./wrpac.js";
import {
  authorityKeyIdentifier,
  basicConstraints,
  certificatePolicies,
  issueCertificate,
  keyUsage,
  type NameAttribute,
  OID,
  randomSerial,
  type Signer,
  subjectKeyIdentifier,
} from "./x509.js";

/**
 * A participant PID Provider's signing certificate, issued by the sandbox PID CA (S5, specification
 * J7, decision D2: sandbox-issued first), and its defect variants (§5.3).
 *
 * The PID list carries the sandbox PID CA as the anchor of its participants' PIDs, so a correct
 * certificate needs no change to the list: that is what "sandbox-issued first" buys. A brought-in CA
 * (v1.1) would.
 *
 * Profile: an end-entity signing certificate of a legal person — `C`, `O` prefixed `TEST`, the
 * `organizationIdentifier` the WRPAC carries, `CN` the service's trade name; KeyUsage
 * `digitalSignature` only; SKI, AKI, the sandbox policy. The PID Rulebook requires the PID Provider's
 * certificate to verify the PID signature (`AS-AP-10-007`, `ISSU_07`); it does not profile it further
 * in what the sandbox has read, and nothing here claims more.
 */
export const PID_VARIANTS = ["PID-00", "PID-01", "PID-02", "PID-03"] as const;
export type PidVariant = (typeof PID_VARIANTS)[number];
/** The signing-certificate variants; PID-03 is a revocation of a correct PID, not a certificate. */
export type PidSigningVariant = Exclude<PidVariant, "PID-03">;

export interface PidVariantInfo {
  readonly title: string;
  readonly issuer: "pid-ca" | "pid-ca-untrusted";
  readonly requirement: string;
}

export const PID_VARIANT_INFO: Readonly<Record<PidVariant, PidVariantInfo>> = {
  "PID-00": { title: "Correct", issuer: "pid-ca", requirement: "—" },
  "PID-01": {
    title: "Signing certificate not on the PID list",
    issuer: "pid-ca-untrusted",
    requirement: "AS-AP-10-007 (ISSU_07)",
  },
  "PID-02": {
    title: "Signing certificate expired",
    issuer: "pid-ca",
    requirement: "AS-AP-10-007 (ISSU_07)",
  },
  "PID-03": {
    title: "Revoked PID (a correct PID, then revoked)",
    issuer: "pid-ca",
    requirement: "AS-AP-07-007 (VCR_04), and the verifier's status check",
  },
};

export const PID_SIGNING_VALIDITY_DAYS = 365;
const DAY = 86_400_000;

export interface IssuePidSigningInput {
  readonly variant: PidSigningVariant;
  readonly subject: {
    readonly legalName: string;
    readonly tradeName: string;
    readonly country: string;
    readonly localIdentifier: string;
  };
  readonly subjectPublicKey: KeyObject;
  readonly issuer: { readonly name: readonly NameAttribute[]; readonly signer: Signer };
  readonly now: Date;
}

export function issuePidSigningCertificate(input: IssuePidSigningInput): {
  readonly der: Buffer;
  readonly serial: Buffer;
} {
  const { now } = input;
  const expired = input.variant === "PID-02";
  const serial = randomSerial();
  const der = issueCertificate(
    {
      serial,
      issuer: input.issuer.name,
      subject: [
        { type: OID.countryName, value: input.subject.country },
        { type: OID.organizationName, value: `${TEST_NAME_PREFIX}${input.subject.legalName}` },
        { type: OID.organizationIdentifier, value: input.subject.localIdentifier },
        { type: OID.commonName, value: input.subject.tradeName },
      ],
      notBefore: expired ? new Date(now.getTime() - 400 * DAY) : now,
      notAfter: expired
        ? new Date(now.getTime() - DAY)
        : new Date(now.getTime() + PID_SIGNING_VALIDITY_DAYS * DAY),
      subjectPublicKey: input.subjectPublicKey,
      extensions: [
        basicConstraints(false),
        keyUsage(["digitalSignature"]),
        subjectKeyIdentifier(input.subjectPublicKey),
        authorityKeyIdentifier(input.issuer.signer.publicKey),
        certificatePolicies([{ policy: SANDBOX_POLICY_OID }]),
      ],
    },
    input.issuer.signer,
  );
  return { der, serial };
}
