import { X509Certificate } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import { signCompactJws } from "./jws.js";
import type { Signer } from "./x509.js";

/**
 * IETF Token Status List, one bit per entry, as a JWT (`statuslist+jwt`) — the revocation
 * mechanism of a registration certificate (ETSI TS 119 475 V1.2.1 CSS-6.2.3.10: no CRL or OCSP for
 * WRPRCs; GEN-6.2.6.1-04 and the Annex C example for the reference). EUDI Wallet Core 0.30.2 fetches
 * it through statium, which reads `status_list.{bits, lst}`, `sub`, `iat`, `exp` and `ttl`, and
 * checks the signature against the `x5c` leaf and the chain against the WRPRC providers' anchors.
 *
 * `bits` is 1: valid (0) or revoked (1), REV-6.2.6.2-04. Index `i` is bit `i % 8` of byte `i / 8`,
 * least significant first; the byte array is compressed with DEFLATE in the zlib format (RFC 1950)
 * and base64url-encoded.
 */
export const STATUS_VALID = 0;
export const STATUS_REVOKED = 1;

export function encodeStatusBits(revoked: ReadonlySet<number>, size: number): string {
  const bytes = Buffer.alloc(Math.ceil(size / 8));
  for (const index of revoked) {
    if (!Number.isInteger(index) || index < 0 || index >= size)
      throw new Error(`index out of range: ${index}`);
    bytes[index >> 3] = (bytes[index >> 3] ?? 0) | (1 << (index & 7));
  }
  return deflateSync(bytes).toString("base64url");
}

export function readStatusBit(lst: string, index: number): number {
  const bytes = inflateSync(Buffer.from(lst, "base64url"));
  const byte = bytes[index >> 3];
  if (byte === undefined) throw new Error("index beyond the list");
  return (byte >> (index & 7)) & 1;
}

export interface StatusListToken {
  /** The list's own URI, which a referencing certificate names (`status.status_list.uri`). */
  readonly uri: string;
  readonly revoked: ReadonlySet<number>;
  readonly size: number;
  readonly issuedAt: Date;
  /** How long the token is valid. A day: the list is re-signed on every change and at least daily. */
  readonly validitySeconds: number;
  /** How long a relying party may cache it before fetching again. */
  readonly ttlSeconds: number;
  readonly signer: Signer;
  /** The signer's chain, leaf first, as `x5c`. */
  readonly chain: readonly Buffer[];
}

export function signStatusListToken(token: StatusListToken): string {
  const iat = Math.floor(token.issuedAt.getTime() / 1000);
  // Defence against ourselves: the leaf in x5c must be the key that signs.
  const leaf = token.chain[0];
  if (!leaf) throw new Error("a status list token needs its signer's certificate");
  const leafKey = new X509Certificate(leaf).publicKey.export({ format: "jwk" });
  if (leafKey.x !== token.signer.publicKey.export({ format: "jwk" }).x) {
    throw new Error("the x5c leaf is not the signing key");
  }
  return signCompactJws(
    { typ: "statuslist+jwt", x5c: token.chain.map((c) => c.toString("base64")) },
    {
      sub: token.uri,
      iat,
      exp: iat + token.validitySeconds,
      ttl: token.ttlSeconds,
      status_list: { bits: 1, lst: encodeStatusBits(token.revoked, token.size) },
    },
    token.signer,
  );
}
