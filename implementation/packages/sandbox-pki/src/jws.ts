import { type KeyObject, verify, X509Certificate } from "node:crypto";
import { children, decode, Tag } from "./der.js";
import type { Signer } from "./x509.js";

/**
 * Compact JWS with ES256 (RFC 7515, RFC 7518 §3.4).
 *
 * A JOSE ECDSA signature is the raw `r || s`, 32 bytes each, not the DER `Ecdsa-Sig-Value` the
 * sandbox's `Signer` produces for X.509; the conversion is here, once.
 */
export const b64u = (value: Buffer | string): string =>
  Buffer.from(value).toString("base64url");

/** DER `SEQUENCE { INTEGER r, INTEGER s }` → JOSE `r || s` for P-256. */
export function derToJose(signature: Buffer): Buffer {
  const [r, s] = children(decode(signature));
  if (!r || !s || r.tag !== Tag.INTEGER || s.tag !== Tag.INTEGER)
    throw new Error("not an ECDSA signature");
  const fixed = (n: Buffer) => {
    let v = n;
    while (v.length > 32 && v[0] === 0) v = v.subarray(1);
    if (v.length > 32) throw new Error("ECDSA integer too long for P-256");
    return Buffer.concat([Buffer.alloc(32 - v.length), v]);
  };
  return Buffer.concat([fixed(r.content), fixed(s.content)]);
}

export function signCompactJws(
  header: Record<string, unknown>,
  payload: Record<string, unknown> | string,
  signer: Signer,
): string {
  const protectedHeader = b64u(JSON.stringify({ alg: "ES256", ...header }));
  const body = b64u(typeof payload === "string" ? payload : JSON.stringify(payload));
  const input = Buffer.from(`${protectedHeader}.${body}`, "ascii");
  return `${protectedHeader}.${body}.${b64u(derToJose(signer.sign(input)))}`;
}

export interface DecodedJws {
  readonly header: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
  readonly signingInput: Buffer;
  readonly signature: Buffer;
}

export function decodeCompactJws(compact: string): DecodedJws {
  const parts = compact.split(".");
  if (parts.length !== 3) throw new Error("not a compact JWS");
  const [h, p, s] = parts as [string, string, string];
  return {
    header: JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as Record<string, unknown>,
    payload: JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >,
    signingInput: Buffer.from(`${h}.${p}`, "ascii"),
    signature: Buffer.from(s, "base64url"),
  };
}

/** Verify an ES256 compact JWS against a public key. */
export function verifyEs256(jws: DecodedJws, key: KeyObject): boolean {
  if (jws.header.alg !== "ES256" || jws.signature.length !== 64) return false;
  return verify("sha256", jws.signingInput, { key, dsaEncoding: "ieee-p1363" }, jws.signature);
}

/** The certificates of an `x5c` header, leaf first; empty when absent or unreadable. */
export function x5cCertificates(header: Record<string, unknown>): X509Certificate[] {
  const x5c = header.x5c;
  if (!Array.isArray(x5c)) return [];
  try {
    return x5c.map((c) => new X509Certificate(Buffer.from(String(c), "base64")));
  } catch {
    return [];
  }
}
