import { X509Certificate } from "node:crypto";
import { PlatformError } from "@edtp/shared";

/**
 * Reads when a supplied certificate chain stops being usable.
 *
 * ## Why the platform reads this at all
 *
 * It holds no key material. A certificate is imported into the engine and what comes back is an
 * opaque key-chain reference, which is the right posture — there is no platform-side private key to
 * protect, dump or log. The cost is that the platform knows nothing else about the key, including
 * whether it still works.
 *
 * On 16 September 2026 that cost an afternoon. The attestation-signing certificate had expired the
 * day before; the credential offer minted, resolved over public HTTPS, the token endpoint issued a
 * DPoP-bound access token, the nonce endpoint answered — and the refusal came only at the last call
 * of the flow, as `400 credential_request_denied · Certificate expired on 2026-09-15T08:19:35.000Z`.
 * `GET …/provider-authentication` reported nothing, because that report answers trust gate (a) and
 * this is the attestation key.
 *
 * A validity window is not key material, not a credential and not content. Recording it is the
 * smallest thing that lets the platform say "this provider cannot sign" before a user finds out.
 *
 * ## The leaf, not the anchor
 *
 * Chains are supplied leaf-first — `CLAUDE.md` §6.11 for the access usage, and the engine's import
 * expects the same order for attestation keys. The leaf is what signs and the leaf is what expires
 * first, so the chain's usable life is the leaf's `notAfter`. A CA that expires sooner than its own
 * leaf is a malformed chain, and diagnosing that is the engine's job, not this function's.
 */
export const certificateChainNotAfter = (chain: readonly string[], what: string): Date => {
  const [leaf] = chain;
  if (!leaf) {
    throw PlatformError.validation(
      "certificate_chain_empty",
      `The ${what} chain is empty. Supply it leaf-first, with the certificate that signs at index 0.`,
    );
  }

  let parsed: X509Certificate;
  try {
    parsed = new X509Certificate(leaf);
  } catch {
    // Deliberately not echoing the input: a malformed PEM is still supplied material, and the
    // message a caller needs is which certificate failed, not what its bytes were.
    throw PlatformError.validation(
      "certificate_unreadable",
      `The ${what} could not be read as a certificate. Expected PEM, leaf first.`,
    );
  }

  const notAfter = new Date(parsed.validTo);
  if (Number.isNaN(notAfter.getTime())) {
    throw PlatformError.validation(
      "certificate_validity_unreadable",
      `The ${what} has no readable expiry date.`,
    );
  }
  return notAfter;
};
