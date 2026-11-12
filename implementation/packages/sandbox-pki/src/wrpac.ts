import type { KeyObject } from "node:crypto";
import { SANDBOX_POLICY_OID } from "./trust-domain.js";
import {
  authorityInfoAccessCaIssuers,
  authorityKeyIdentifier,
  basicConstraints,
  certificatePolicies,
  crlDistributionPoint,
  type Extension,
  extendedKeyUsage,
  type GeneralName,
  issueCertificate,
  keyUsage,
  type NameAttribute,
  OID,
  randomSerial,
  type Signer,
  semanticsInformation,
  subjectAltName,
  subjectKeyIdentifier,
} from "./x509.js";

/**
 * The wallet-relying party access certificate (WRPAC), `docs/sandbox/specification.md` §7.1, and its
 * defect variants (§5.1).
 *
 * Profile sources, as read on 12 November 2026:
 * - ETSI TS 119 411-8 V1.1.1 §5.3 (policy `0.4.0.194118.1.2`), GEN-6.6.1-03/-05/-06/-07/-08;
 * - ETSI TS 119 475 V1.2.1 §5.1 Table 1 (subject of a legal person), Annex E Table E.1 (no
 *   entitlements in the WRPAC);
 * - EN 319 412-1 V1.7.1 LEG-5.1.4-03/-05 (`SB:` locally defined identifier, with its registration
 *   authority in the SemanticsInformation);
 * - EN 319 412-2 V2.5.1 / -3 V1.4.1: KeyUsage one setting (`digitalSignature`), AKI, certificate
 *   policies, CRL distribution point and AIA `caIssuers` present.
 *
 * The `dNSName` is the sandbox's own addition: none of those texts mentions one, but the pinned
 * wallet's `x509_san_dns` client identifier scheme needs it.
 */

/** NCP-l-eudiwrp, TS 119 411-8 V1.1.1 §5.3. */
export const WRPAC_POLICY_LEGAL = "0.4.0.194118.1.2";

export const WRPAC_VARIANTS = [
  "AC-00",
  "AC-01",
  "AC-02",
  "AC-03",
  "AC-04",
  "AC-05",
  "AC-06",
] as const;
export type WrpacVariant = (typeof WRPAC_VARIANTS)[number];

export interface WrpacVariantInfo {
  readonly title: string;
  /** The trust-domain CA that signs it: the untrusted one only for the unknown-issuer defect. */
  readonly issuer: "access-ca" | "access-ca-untrusted";
  /** The self-test check this variant is built to fail, or none for the correct certificate. */
  readonly fails?: WrpacCheck;
  /** The requirement a wallet's reaction is measured against (specification §5.1). */
  readonly requirement: string;
}

export const WRPAC_CHECKS = [
  "trusted_issuer",
  "validity",
  "not_revoked",
  "organization_identifier",
  "san_dns",
  "key_usage",
] as const;
export type WrpacCheck = (typeof WRPAC_CHECKS)[number];

export const WRPAC_VARIANT_INFO: Readonly<Record<WrpacVariant, WrpacVariantInfo>> = {
  "AC-00": { title: "Correct", issuer: "access-ca", requirement: "—" },
  "AC-01": {
    title: "Unknown CA",
    issuer: "access-ca-untrusted",
    fails: "trusted_issuer",
    requirement: "AS-WP-06-005 (RPA_04); issuance AS-AP-10-061 (ISSU_34)",
  },
  "AC-02": {
    title: "Expired",
    issuer: "access-ca",
    fails: "validity",
    requirement: "AS-WP-06-006 (RPA_05); ISSU_34",
  },
  "AC-03": {
    title: "Not yet valid",
    issuer: "access-ca",
    fails: "validity",
    requirement: "AS-WP-06-006 (RPA_05); ISSU_34",
  },
  "AC-04": {
    title: "Revoked",
    issuer: "access-ca",
    fails: "not_revoked",
    requirement: "No HLR — ARF §6.6.3.2 prose; AS-MS-27-019 (Reg_12) obliges revocability",
  },
  "AC-05": {
    title: "Missing organizationIdentifier",
    issuer: "access-ca",
    fails: "organization_identifier",
    requirement: "ETSI TS 119 411-8 GEN-6.6.1-05; registration certificate binding (RC-06)",
  },
  "AC-06": {
    title: "No dNSName for the verifier's host",
    issuer: "access-ca",
    fails: "san_dns",
    requirement: "OpenID4VP x509_san_dns client identifier — no ARF identifier",
  },
};

export interface WrpacSubjectData {
  readonly legalName: string;
  readonly tradeName: string;
  readonly country: string;
  /** `SB:<CC>-<n>` (specification Q-S1). */
  readonly localIdentifier: string;
  readonly serviceIdentifier: string;
  readonly supportUri: string;
  readonly dnsNames: readonly string[];
}

export interface WrpacUrls {
  readonly cps: string;
  readonly crl: string;
  readonly caIssuers: string;
  /** The sandbox register, named as the identifier's registration authority (LEG-5.1.4-05). */
  readonly register: string;
}

export const WRPAC_VALIDITY_DAYS = 90;
const DAY = 86_400_000;

/** Organisation names in every sandbox certificate start with this (ADR 0014 Decision 7). */
export const TEST_NAME_PREFIX = "TEST ";

export function wrpacSubject(data: WrpacSubjectData, withIdentifier = true): NameAttribute[] {
  return [
    { type: OID.countryName, value: data.country },
    { type: OID.organizationName, value: `${TEST_NAME_PREFIX}${data.legalName}` },
    ...(withIdentifier
      ? [{ type: OID.organizationIdentifier, value: data.localIdentifier }]
      : []),
    { type: OID.organizationalUnitName, value: data.serviceIdentifier },
    { type: OID.commonName, value: data.tradeName },
  ];
}

const HOST = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

/** A DNS name the sandbox will put in a certificate: lower-case, dotted, no wildcard, no IP. */
export const isAcceptableDnsName = (name: string): boolean =>
  HOST.test(name) && !/^\d+(\.\d+)+$/.test(name);

export interface IssueWrpacInput {
  readonly variant: WrpacVariant;
  readonly subject: WrpacSubjectData;
  readonly subjectPublicKey: KeyObject;
  readonly issuer: { readonly name: readonly NameAttribute[]; readonly signer: Signer };
  readonly urls: WrpacUrls;
  readonly now: Date;
  readonly serial?: Buffer;
}

/**
 * Issue a WRPAC with the given variant. AC-04 is issued correct and becomes defective when it is
 * revoked; AC-01 is correct apart from its issuer, which the caller chooses from
 * `WRPAC_VARIANT_INFO`.
 */
export function issueWrpac(input: IssueWrpacInput): {
  readonly der: Buffer;
  readonly serial: Buffer;
} {
  const { variant, subject, now } = input;
  for (const name of subject.dnsNames) {
    if (!isAcceptableDnsName(name)) throw new Error(`not an acceptable DNS name: ${name}`);
  }
  let notBefore = now;
  let notAfter = new Date(now.getTime() + WRPAC_VALIDITY_DAYS * DAY);
  if (variant === "AC-02") {
    notBefore = new Date(now.getTime() - 120 * DAY);
    notAfter = new Date(now.getTime() - 30 * DAY);
  }
  if (variant === "AC-03") {
    notBefore = new Date(now.getTime() + 30 * DAY);
    notAfter = new Date(now.getTime() + 120 * DAY);
  }
  const names: GeneralName[] = [
    { kind: "uri", value: subject.supportUri },
    ...(variant === "AC-06"
      ? []
      : subject.dnsNames.map((value) => ({ kind: "dns" as const, value }))),
  ];
  const withIdentifier = variant !== "AC-05";
  const extensions: Extension[] = [
    basicConstraints(false),
    keyUsage(["digitalSignature"]),
    extendedKeyUsage([OID.clientAuth]),
    subjectKeyIdentifier(input.subjectPublicKey),
    authorityKeyIdentifier(input.issuer.signer.publicKey),
    subjectAltName(names),
    certificatePolicies([
      { policy: WRPAC_POLICY_LEGAL, cpsUri: input.urls.cps },
      { policy: SANDBOX_POLICY_OID },
    ]),
    crlDistributionPoint(input.urls.crl),
    authorityInfoAccessCaIssuers(input.urls.caIssuers),
    ...(withIdentifier
      ? [semanticsInformation(OID.semanticsIdLegal, input.urls.register)]
      : []),
  ];
  const serial = input.serial ?? randomSerial();
  const der = issueCertificate(
    {
      serial,
      issuer: input.issuer.name,
      subject: wrpacSubject(subject, withIdentifier),
      notBefore,
      notAfter,
      subjectPublicKey: input.subjectPublicKey,
      extensions,
    },
    input.issuer.signer,
  );
  return { der, serial };
}
