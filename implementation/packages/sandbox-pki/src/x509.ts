import { createHash, createPublicKey, type KeyObject, randomBytes, verify } from "node:crypto";
import {
  bitString,
  boolean,
  children,
  type Der,
  decode,
  decodeOid,
  explicit,
  ia5String,
  implicitConstructed,
  implicitPrimitive,
  integer,
  namedBits,
  octetString,
  oid,
  printableString,
  sequence,
  setOf,
  Tag,
  time,
  unsignedInteger,
  utf8String,
} from "./der.js";

/**
 * X.509 v3 certificates and v2 CRLs (RFC 5280), ECDSA P-256 with SHA-256 only.
 *
 * The profile decisions — which extensions a WRPAC carries, and why — live in the profile modules
 * that call this one; this module only encodes what it is given, faithfully, including values a
 * correct profile would never use. That is deliberate: the defect catalogue
 * (`docs/sandbox/specification.md` §5) needs an encoder that does not second-guess it.
 */

export const OID = {
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  ecPublicKey: "1.2.840.10045.2.1",
  prime256v1: "1.2.840.10045.3.1.7",
  countryName: "2.5.4.6",
  organizationName: "2.5.4.10",
  organizationalUnitName: "2.5.4.11",
  commonName: "2.5.4.3",
  serialNumber: "2.5.4.5",
  givenName: "2.5.4.42",
  surname: "2.5.4.4",
  organizationIdentifier: "2.5.4.97",
  subjectKeyIdentifier: "2.5.29.14",
  keyUsage: "2.5.29.15",
  subjectAltName: "2.5.29.17",
  basicConstraints: "2.5.29.19",
  cRLNumber: "2.5.29.20",
  cRLReason: "2.5.29.21",
  cRLDistributionPoints: "2.5.29.31",
  certificatePolicies: "2.5.29.32",
  authorityKeyIdentifier: "2.5.29.35",
  extKeyUsage: "2.5.29.37",
  clientAuth: "1.3.6.1.5.5.7.3.2",
  cpsQualifier: "1.3.6.1.5.5.7.2.1",
  authorityInfoAccess: "1.3.6.1.5.5.7.1.1",
  caIssuers: "1.3.6.1.5.5.7.48.2",
  qcStatements: "1.3.6.1.5.5.7.1.3",
  pkixQcSyntaxV2: "1.3.6.1.5.5.7.11.2",
  /** `id-etsi-qcs-semanticsId-Legal`, EN 319 412-1 §5.1.4. */
  semanticsIdLegal: "0.4.0.194121.1.2",
} as const;

/** KeyUsage bit numbers, RFC 5280 §4.2.1.3. */
export const KeyUsageBit = {
  digitalSignature: 0,
  nonRepudiation: 1,
  keyEncipherment: 2,
  dataEncipherment: 3,
  keyAgreement: 4,
  keyCertSign: 5,
  cRLSign: 6,
} as const;
export type KeyUsageName = keyof typeof KeyUsageBit;

/** What signs: a public key to publish and a function over the to-be-signed bytes. */
export interface Signer {
  readonly publicKey: KeyObject;
  /** ECDSA P-256 / SHA-256, DER-encoded `Ecdsa-Sig-Value` (RFC 5480). */
  sign(data: Buffer): Buffer;
}

// --- Names -----------------------------------------------------------------------------------

export interface NameAttribute {
  readonly type: string;
  readonly value: string;
}

/** Attributes whose syntax is PrintableString (RFC 5280 Appendix A): country and serial number. */
const PRINTABLE_ATTRIBUTES: ReadonlySet<string> = new Set([OID.countryName, OID.serialNumber]);

/** A Name with one attribute per RDN, in the order given — the order shown by most tools. */
export function encodeName(attributes: readonly NameAttribute[]): Der {
  return sequence(
    ...attributes.map((a) =>
      setOf(
        sequence(
          oid(a.type),
          PRINTABLE_ATTRIBUTES.has(a.type) ? printableString(a.value) : utf8String(a.value),
        ),
      ),
    ),
  );
}

// --- Extensions ------------------------------------------------------------------------------

export interface Extension {
  readonly oid: string;
  readonly critical: boolean;
  /** The extension value's DER, before it is wrapped in the OCTET STRING. */
  readonly value: Der;
}

function encodeExtension(e: Extension): Der {
  return sequence(oid(e.oid), ...(e.critical ? [boolean(true)] : []), octetString(e.value));
}

export const basicConstraints = (ca: boolean, pathLength?: number): Extension => ({
  oid: OID.basicConstraints,
  critical: true,
  value: sequence(
    ...(ca ? [boolean(true)] : []),
    ...(ca && pathLength !== undefined ? [integer(pathLength)] : []),
  ),
});

export const keyUsage = (usages: readonly KeyUsageName[]): Extension => ({
  oid: OID.keyUsage,
  critical: true,
  value: namedBits(usages.map((u) => KeyUsageBit[u])),
});

export const extendedKeyUsage = (purposes: readonly string[]): Extension => ({
  oid: OID.extKeyUsage,
  critical: false,
  value: sequence(...purposes.map(oid)),
});

/** RFC 5280 §4.2.1.2 method (1): SHA-1 over the subjectPublicKey BIT STRING's value. */
export function keyIdentifier(publicKey: KeyObject): Buffer {
  const spki = decode(spkiDer(publicKey));
  const keyBits = children(spki)[1];
  if (!keyBits || keyBits.tag !== Tag.BIT_STRING)
    throw new Error("malformed SubjectPublicKeyInfo");
  return createHash("sha1").update(keyBits.content.subarray(1)).digest();
}

export const subjectKeyIdentifier = (publicKey: KeyObject): Extension => ({
  oid: OID.subjectKeyIdentifier,
  critical: false,
  value: octetString(keyIdentifier(publicKey)),
});

export const authorityKeyIdentifier = (issuerKey: KeyObject): Extension => ({
  oid: OID.authorityKeyIdentifier,
  critical: false,
  value: sequence(implicitPrimitive(0, keyIdentifier(issuerKey))),
});

export type GeneralName =
  | { readonly kind: "dns"; readonly value: string }
  | { readonly kind: "uri"; readonly value: string }
  | { readonly kind: "email"; readonly value: string };

function encodeGeneralName(name: GeneralName): Der {
  const ascii = (v: string) => ia5String(v).subarray(2); // content octets only
  switch (name.kind) {
    case "email":
      return implicitPrimitive(1, ascii(name.value));
    case "dns":
      return implicitPrimitive(2, ascii(name.value));
    case "uri":
      return implicitPrimitive(6, ascii(name.value));
  }
}

export const subjectAltName = (names: readonly GeneralName[]): Extension => ({
  oid: OID.subjectAltName,
  critical: false,
  value: sequence(...names.map(encodeGeneralName)),
});

export interface PolicyInformation {
  readonly policy: string;
  /** A CPS pointer qualifier (RFC 5280 §4.2.1.4), as TS 119 411-8 GEN-6.6.1-06 asks. */
  readonly cpsUri?: string;
}

export const certificatePolicies = (policies: readonly PolicyInformation[]): Extension => ({
  oid: OID.certificatePolicies,
  critical: false,
  value: sequence(
    ...policies.map((p) =>
      sequence(
        oid(p.policy),
        ...(p.cpsUri ? [sequence(sequence(oid(OID.cpsQualifier), ia5String(p.cpsUri)))] : []),
      ),
    ),
  ),
});

/** One distribution point naming a URI: `DistributionPoint { [0] { [0] fullName { [6] uri } } }`. */
export const crlDistributionPoint = (uri: string): Extension => ({
  oid: OID.cRLDistributionPoints,
  critical: false,
  value: sequence(
    sequence(
      explicit(0, implicitConstructed(0, encodeGeneralName({ kind: "uri", value: uri }))),
    ),
  ),
});

/**
 * Authority information access with one `id-ad-caIssuers` URI. EN 319 412-2 V2.5.1 GEN-4.4.1-2/-3
 * require it in an end-entity certificate even when no OCSP responder exists.
 */
export const authorityInfoAccessCaIssuers = (uri: string): Extension => ({
  oid: OID.authorityInfoAccess,
  critical: false,
  value: sequence(sequence(oid(OID.caIssuers), encodeGeneralName({ kind: "uri", value: uri }))),
});

/**
 * A `qcStatements` extension (RFC 3739 §3.2.6) holding one `id-qcs-pkixQCSyntax-v2` statement whose
 * SemanticsInformation names the identifier's semantics and its name registration authority.
 *
 * EN 319 412-1 V1.7.1 LEG-5.1.4-05: a locally defined identity type reference (two characters and
 * ":") requires `nameRegistrationAuthorities` with at least a URI. This is how a sandbox
 * organisation's `organizationIdentifier` says whose scheme it is.
 */
export const semanticsInformation = (
  semanticsId: string,
  registrationAuthorityUri: string,
): Extension => ({
  oid: OID.qcStatements,
  critical: false,
  value: sequence(
    sequence(
      oid(OID.pkixQcSyntaxV2),
      sequence(
        oid(semanticsId),
        sequence(encodeGeneralName({ kind: "uri", value: registrationAuthorityUri })),
      ),
    ),
  ),
});

// --- Keys ------------------------------------------------------------------------------------

export function spkiDer(publicKey: KeyObject): Buffer {
  return publicKey.export({ type: "spki", format: "der" });
}

/** Refuse anything but an EC P-256 key: the only kind the sandbox issues for or signs with. */
export function assertP256(publicKey: KeyObject): void {
  if (
    publicKey.asymmetricKeyType !== "ec" ||
    publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  ) {
    throw new Error("only EC P-256 keys are accepted");
  }
}

const SIGNATURE_ALGORITHM = sequence(oid(OID.ecdsaWithSha256));

/** A positive 128-bit serial number, unpredictable as CA/B practice recommends. */
export function randomSerial(): Buffer {
  const bytes = randomBytes(16);
  bytes[0] = (bytes[0] ?? 0) & 0x7f;
  return bytes;
}

// --- Certificates ----------------------------------------------------------------------------

export interface CertificateTemplate {
  readonly serial: Buffer;
  readonly issuer: readonly NameAttribute[];
  readonly subject: readonly NameAttribute[];
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly subjectPublicKey: KeyObject;
  readonly extensions: readonly Extension[];
}

/** Encode and sign a certificate. Returns its DER. */
export function issueCertificate(template: CertificateTemplate, signer: Signer): Buffer {
  assertP256(template.subjectPublicKey);
  const tbs = sequence(
    explicit(0, integer(2)),
    unsignedInteger(template.serial),
    SIGNATURE_ALGORITHM,
    encodeName(template.issuer),
    sequence(time(template.notBefore), time(template.notAfter)),
    encodeName(template.subject),
    spkiDer(template.subjectPublicKey),
    ...(template.extensions.length
      ? [explicit(3, sequence(...template.extensions.map(encodeExtension)))]
      : []),
  );
  return sequence(tbs, SIGNATURE_ALGORITHM, bitString(signer.sign(tbs)));
}

// --- CRLs ------------------------------------------------------------------------------------

export interface RevokedEntry {
  readonly serial: Buffer;
  readonly revokedAt: Date;
}

export interface CrlTemplate {
  readonly issuer: readonly NameAttribute[];
  readonly thisUpdate: Date;
  readonly nextUpdate: Date;
  /** Monotonically increasing, RFC 5280 §5.2.3. */
  readonly crlNumber: bigint;
  readonly revoked: readonly RevokedEntry[];
}

/** Encode and sign a v2 CRL with the AKI and CRL number extensions RFC 5280 §5.2 requires. */
export function issueCrl(template: CrlTemplate, signer: Signer): Buffer {
  const entries = template.revoked.map((r) =>
    sequence(unsignedInteger(r.serial), time(r.revokedAt)),
  );
  const tbs = sequence(
    integer(1),
    SIGNATURE_ALGORITHM,
    encodeName(template.issuer),
    time(template.thisUpdate),
    time(template.nextUpdate),
    ...(entries.length ? [sequence(...entries)] : []),
    explicit(
      0,
      sequence(
        encodeExtension(authorityKeyIdentifier(signer.publicKey)),
        encodeExtension({
          oid: OID.cRLNumber,
          critical: false,
          value: integer(template.crlNumber),
        }),
      ),
    ),
  );
  return sequence(tbs, SIGNATURE_ALGORITHM, bitString(signer.sign(tbs)));
}

// --- Certification requests ------------------------------------------------------------------

/** Uploaded requests larger than this are refused before parsing. A P-256 CSR is about 400 bytes. */
export const MAX_CSR_BYTES = 8 * 1024;

/**
 * Read a PKCS#10 request (RFC 2986) and return its public key, after checking its
 * proof of possession.
 *
 * Only the key is used. The sandbox takes the subject and every extension from the register, never
 * from the request — TS 119 411-8 GEN-6.6.1-10 derives the certificate's attributes from the
 * registration — so nothing else in the request is read, and nothing in it can steer the
 * certificate.
 */
export function readCertificationRequest(der: Buffer): KeyObject {
  if (der.length > MAX_CSR_BYTES) throw new Error("certification request too large");
  const request = decode(der);
  const [info, algorithm, signature] = children(request);
  if (!info || !algorithm || !signature || children(request).length !== 3) {
    throw new Error("malformed certification request");
  }
  const [version, , spki] = children(info);
  if (!version || version.tag !== Tag.INTEGER || !version.content.equals(Buffer.from([0]))) {
    throw new Error("unsupported certification request version");
  }
  if (!spki || spki.tag !== Tag.SEQUENCE) throw new Error("malformed certification request");
  const algorithmOid = children(algorithm)[0];
  if (!algorithmOid || decodeOid(algorithmOid) !== OID.ecdsaWithSha256) {
    throw new Error("certification request must be signed with ecdsa-with-SHA256");
  }
  if (signature.tag !== Tag.BIT_STRING || signature.content[0] !== 0) {
    throw new Error("malformed certification request signature");
  }
  const publicKey = createPublicKey({ key: spki.raw, format: "der", type: "spki" });
  assertP256(publicKey);
  const valid = verify(
    "sha256",
    info.raw,
    { key: publicKey, dsaEncoding: "der" },
    signature.content.subarray(1),
  );
  if (!valid) throw new Error("certification request signature does not verify");
  return publicKey;
}

/** PEM armour, 64 characters a line (RFC 7468). */
export function toPem(der: Buffer, label: "CERTIFICATE" | "X509 CRL"): string {
  const body = der
    .toString("base64")
    .replace(/(.{64})/g, "$1\n")
    .replace(/\n$/, "");
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

// --- Reading -----------------------------------------------------------------------------------

/** The extensions of a certificate, by OID: whether critical, and the value's DER. */
export function readExtensions(
  certificate: Buffer,
): Map<string, { critical: boolean; value: Buffer }> {
  const [tbs] = children(decode(certificate));
  if (!tbs) throw new Error("malformed certificate");
  const wrapper = children(tbs).find((e) => e.tag === 0xa3);
  const out = new Map<string, { critical: boolean; value: Buffer }>();
  if (!wrapper) return out;
  const [list] = children(wrapper);
  for (const ext of list ? children(list) : []) {
    const parts = children(ext);
    const id = parts[0];
    const last = parts[parts.length - 1];
    if (!id || !last) continue;
    out.set(decodeOid(id), { critical: parts.length === 3, value: last.content });
  }
  return out;
}

/** The KeyUsage bits set in a certificate, by name. */
export function readKeyUsage(certificate: Buffer): KeyUsageName[] {
  const ext = readExtensions(certificate).get(OID.keyUsage);
  if (!ext) return [];
  const bits = decode(ext.value);
  const bytes = bits.content.subarray(1);
  return (Object.entries(KeyUsageBit) as [KeyUsageName, number][])
    .filter(([, bit]) => ((bytes[bit >> 3] ?? 0) & (0x80 >> (bit & 7))) !== 0)
    .map(([name]) => name);
}

/**
 * A serial number as Node's `X509Certificate.serialNumber` shows it: upper-case hex of the DER
 * integer's magnitude — leading zero *bytes* removed, never a leading zero nibble of a byte.
 */
export const serialToHex = (serial: Buffer): string => {
  let start = 0;
  while (start < serial.length - 1 && serial[start] === 0) start++;
  return serial.subarray(start).toString("hex").toUpperCase();
};

export const hexToSerial = (hex: string): Buffer =>
  Buffer.from(hex.length % 2 ? `0${hex}` : hex, "hex");
