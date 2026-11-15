import { createHash, X509Certificate } from "node:crypto";

/**
 * The check on a certificate a Wallet Provider uploads (ADR 0020 §2), before anything is stored.
 *
 * Only a public certificate is accepted: any input carrying a private key is refused outright, so a
 * pasted key never reaches the platform's storage. The engine matches a CA when an attestation's
 * chain ends at it, and any other certificate only as the exact signer (`interop-findings.md` A36),
 * so both are accepted and the kind is reported.
 */
export type WalletProviderAnchorRefusal =
  | "contains_private_key"
  | "not_one_certificate"
  | "unparseable"
  | "expired"
  | "not_yet_valid"
  | "validity_too_long"
  | "unsupported_key"
  | "ca_without_key_cert_sign"
  | "leaf_without_digital_signature";

export interface InspectedWalletProviderAnchor {
  readonly kind: "ca" | "signer";
  readonly der: Buffer;
  /** SHA-256 of the DER, lower-case hex: the identity the engine and the list use. */
  readonly fingerprint: string;
  readonly subject: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
}

const MAX_VALIDITY_MS = 20 * 366 * 86_400_000;
const PEM = /-----BEGIN CERTIFICATE-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END CERTIFICATE-----/g;

export function inspectWalletProviderAnchor(
  input: string,
  now: Date,
):
  | { readonly ok: true; readonly anchor: InspectedWalletProviderAnchor }
  | { readonly ok: false; readonly refusal: WalletProviderAnchorRefusal } {
  if (/PRIVATE KEY/i.test(input)) return { ok: false, refusal: "contains_private_key" };
  const blocks = [...input.matchAll(PEM)];
  if (blocks.length !== 1) return { ok: false, refusal: "not_one_certificate" };
  const der = Buffer.from((blocks[0]?.[1] ?? "").replace(/\s+/g, ""), "base64");
  let x: X509Certificate;
  try {
    x = new X509Certificate(der);
  } catch {
    return { ok: false, refusal: "unparseable" };
  }
  const notBefore = new Date(x.validFrom);
  const notAfter = new Date(x.validTo);
  if (notAfter.getTime() <= now.getTime()) return { ok: false, refusal: "expired" };
  if (notBefore.getTime() > now.getTime()) return { ok: false, refusal: "not_yet_valid" };
  if (notAfter.getTime() - notBefore.getTime() > MAX_VALIDITY_MS) {
    return { ok: false, refusal: "validity_too_long" };
  }
  const key = x.publicKey;
  const details = key.asymmetricKeyDetails ?? {};
  const keyOk =
    (key.asymmetricKeyType === "ec" &&
      (details.namedCurve === "prime256v1" || details.namedCurve === "secp384r1")) ||
    (key.asymmetricKeyType === "rsa" && (details.modulusLength ?? 0) >= 3072);
  if (!keyOk) return { ok: false, refusal: "unsupported_key" };
  // Node exposes basicConstraints CA as `ca`; key usage only as text, so read the decoded extension.
  const usage = keyUsageOf(x);
  if (x.ca) {
    if (usage && !usage.includes("keyCertSign")) {
      return { ok: false, refusal: "ca_without_key_cert_sign" };
    }
  } else if (usage && !usage.includes("digitalSignature")) {
    return { ok: false, refusal: "leaf_without_digital_signature" };
  }
  return {
    ok: true,
    anchor: {
      kind: x.ca ? "ca" : "signer",
      der,
      fingerprint: createHash("sha256").update(der).digest("hex"),
      subject: x.subject.replace(/\n/g, ", "),
      notBefore,
      notAfter,
    },
  };
}

/**
 * The key-usage bits, by name, or undefined when the extension is absent. Read from the DER: the
 * extension is OID 2.5.29.15, an OCTET STRING wrapping a BIT STRING.
 */
function keyUsageOf(x: X509Certificate): string[] | undefined {
  const raw = x.raw;
  const oid = Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x0f]);
  const at = raw.indexOf(oid);
  if (at < 0) return undefined;
  // After the OID: an optional BOOLEAN (critical), then OCTET STRING { BIT STRING }.
  let i = at + oid.length;
  if (raw[i] === 0x01) i += 3;
  if (raw[i] !== 0x04) return undefined;
  i += 2; // OCTET STRING tag and short length
  if (raw[i] !== 0x03) return undefined;
  const len = raw[i + 1] ?? 0;
  const unused = raw[i + 2] ?? 0;
  const bytes = raw.subarray(i + 3, i + 2 + len);
  const names = [
    "digitalSignature",
    "nonRepudiation",
    "keyEncipherment",
    "dataEncipherment",
    "keyAgreement",
    "keyCertSign",
    "cRLSign",
    "encipherOnly",
    "decipherOnly",
  ];
  const bits: string[] = [];
  names.forEach((name, n) => {
    const byte = bytes[Math.floor(n / 8)];
    if (byte === undefined) return;
    if (n >= bytes.length * 8 - unused) return;
    if (byte & (0x80 >> (n % 8))) bits.push(name);
  });
  return bits;
}
