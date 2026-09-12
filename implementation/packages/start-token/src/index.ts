import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The signed hand-off from the console to the public start page.
 *
 * ## Why this exists, and what it deliberately does not carry
 *
 * A same-device test needs the page that opens the wallet to be **on the phone**, so one page has to
 * be publicly reachable. The design constraint from `docs/test-session-gateway.md` is that nothing
 * public may reach a management route — so the public page is given the finished interaction URI and
 * no way to obtain another one.
 *
 * That makes the public page a **signed-redirect service**: it holds no platform API credential, makes
 * no API call, and cannot create, read or enumerate anything. The worst an attacker with a leaked
 * token can do is open a wallet against a presentation we already created and which expires on its
 * own.
 *
 * The token therefore carries the interaction URI itself rather than a presentation id, which would
 * have required the public page to call the API to resolve it.
 *
 * ## What it is not
 *
 * Not an authentication mechanism and not a capability we would ship. It is a test-harness artefact:
 * short-lived, single-purpose, and tied to a presentation that the engine expires anyway.
 */

/** Two minutes. Long enough to pick up a phone and scan, short enough that a shared link is useless. */
export const START_TOKEN_TTL_SECONDS = 120;

/** `HS256` over a canonical JSON payload. */
const ALGORITHM = "sha256";

export interface StartTokenPayload {
  /** The interaction URI a wallet is to open. Usually an `openid4vp://` request. */
  readonly uri: string;
  /** The presentation this belongs to. Carried for display and for the run record, not for lookup. */
  readonly presentationId: string;
  /** Seconds since the epoch, after which the token is refused. */
  readonly expiresAt: number;
  /** Makes every token distinct, so the public page can refuse a replay it has already seen. */
  readonly nonce: string;
}

const b64url = (value: Buffer | string): string =>
  (Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8")).toString("base64url");

const sign = (secret: string, body: string): string =>
  createHmac(ALGORITHM, secret).update(body).digest("base64url");

/**
 * Mints a token for one interaction URI.
 *
 * The payload is serialised once and the signature covers exactly those bytes, so verification never
 * has to reproduce a canonical form — a re-serialisation mismatch is the classic way this kind of
 * token ends up forgeable.
 */
export const mintStartToken = (
  secret: string,
  input: { uri: string; presentationId: string; nowSeconds: number },
): string => {
  const payload: StartTokenPayload = {
    uri: input.uri,
    presentationId: input.presentationId,
    expiresAt: input.nowSeconds + START_TOKEN_TTL_SECONDS,
    nonce: randomBytes(16).toString("base64url"),
  };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(secret, body)}`;
};

export type StartTokenResult =
  | { readonly ok: true; readonly payload: StartTokenPayload }
  | { readonly ok: false; readonly reason: "malformed" | "bad_signature" | "expired" };

/**
 * Verifies a token.
 *
 * The signature is checked **before** the payload is parsed for meaning, and with a constant-time
 * comparison. Expiry is reported separately from a bad signature for the operator's benefit: "it
 * expired, scan again" and "that token was not issued by this console" are different problems, and the
 * public page shows neither to a visitor in more detail than "this link is no longer valid".
 */
export const verifyStartToken = (
  secret: string,
  token: string,
  nowSeconds: number,
): StartTokenResult => {
  const parts = token.split(".");
  if (parts.length !== 2) {
    return { ok: false, reason: "malformed" };
  }
  const [body, signature] = parts;
  if (!body || !signature) {
    return { ok: false, reason: "malformed" };
  }

  const expected = Buffer.from(sign(secret, body), "utf8");
  const provided = Buffer.from(signature, "utf8");
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return { ok: false, reason: "bad_signature" };
  }

  let payload: StartTokenPayload;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      return { ok: false, reason: "malformed" };
    }
    const candidate = parsed as Record<string, unknown>;
    if (
      typeof candidate["uri"] !== "string" ||
      typeof candidate["presentationId"] !== "string" ||
      typeof candidate["expiresAt"] !== "number" ||
      typeof candidate["nonce"] !== "string"
    ) {
      return { ok: false, reason: "malformed" };
    }
    payload = {
      uri: candidate["uri"],
      presentationId: candidate["presentationId"],
      expiresAt: candidate["expiresAt"],
      nonce: candidate["nonce"],
    };
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (payload.expiresAt <= nowSeconds) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, payload };
};

/**
 * Schemes the public page is willing to send a visitor to.
 *
 * The URI is signed, so this is not defence against forgery — it is defence against *us*. If a future
 * change ever let a token carry an `https://` URL, the public page would become an open redirector
 * that our own signature vouches for. Wallet schemes only, checked at the point of use.
 */
export const PERMITTED_INTERACTION_SCHEMES: readonly string[] = [
  "openid4vp:",
  "eudi-openid4vp:",
  "mdoc-openid4vp:",
  "haip:",
];

export const isPermittedInteractionUri = (uri: string): boolean => {
  try {
    return PERMITTED_INTERACTION_SCHEMES.includes(new URL(uri).protocol);
  } catch {
    return false;
  }
};
