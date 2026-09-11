import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";

/**
 * The operator session.
 *
 * One shared credential and a signed cookie. No user table, no roles, no password reset — the console
 * has no user model by design (`docs/web-interface-proposal.md` §7), and inventing one here would be
 * building a piece of product C by accident.
 *
 * ## Why a login at all, when it binds to localhost
 *
 * Because localhost is not a security boundary. A browser cannot reach it cross-origin without CORS,
 * but anything else running as the same user can, and "it is only on my machine" is how a console with
 * a live tenant key ends up reachable from a devcontainer, an SSH forward someone left open, or a
 * malicious npm postinstall. The login costs thirty lines.
 */

const COOKIE_NAME = "edtp_console_session";
const ALGORITHM = "sha256";

const b64url = (value: Buffer | string): string =>
  (Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8")).toString("base64url");

const sign = (secret: string, body: string): string =>
  createHmac(ALGORITHM, secret).update(body).digest("base64url");

const constantTimeEquals = (a: string, b: string): boolean => {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // `timingSafeEqual` throws on a length mismatch, so the lengths are compared first — which does leak
  // the length. For a password that is acceptable and unavoidable without hashing to a fixed width;
  // what matters is that the *contents* are not compared byte by byte with an early exit.
  return left.length === right.length && timingSafeEqual(left, right);
};

/** Checks the operator password. Separate from cookie handling so it can be tested on its own. */
export const isCorrectPassword = (configured: string, provided: string): boolean =>
  constantTimeEquals(configured, provided);

interface SessionPayload {
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly nonce: string;
}

export const issueSession = (
  response: Response,
  options: { secret: string; ttlSeconds: number; nowSeconds: number; secureCookie: boolean },
): void => {
  const payload: SessionPayload = {
    issuedAt: options.nowSeconds,
    expiresAt: options.nowSeconds + options.ttlSeconds,
    nonce: randomBytes(16).toString("base64url"),
  };
  const body = b64url(JSON.stringify(payload));
  response.cookie(COOKIE_NAME, `${body}.${sign(options.secret, body)}`, {
    httpOnly: true,
    sameSite: "strict",
    // `Secure` is conditional only because the console is reached over `http://127.0.0.1` in normal
    // use, where a browser would drop a `Secure` cookie outright. Anywhere else it is set.
    secure: options.secureCookie,
    path: "/",
    maxAge: options.ttlSeconds * 1_000,
  });
};

export const clearSession = (response: Response): void => {
  response.clearCookie(COOKIE_NAME, { path: "/" });
};

/**
 * Whether the request carries a valid, unexpired session.
 *
 * `SameSite=Strict` plus same-origin form posts is what stands in for CSRF tokens here: a cross-site
 * form post arrives without the cookie, so it cannot act as the operator. That holds because every
 * state-changing route in the console is a `POST` — a `GET` that changed state would quietly undo it,
 * which is why none exists.
 */
export const hasValidSession = (
  request: Request,
  options: { secret: string; nowSeconds: number },
): boolean => {
  const raw = readCookie(request, COOKIE_NAME);
  if (!raw) {
    return false;
  }
  const parts = raw.split(".");
  if (parts.length !== 2) {
    return false;
  }
  const [body, signature] = parts;
  if (!body || !signature || !constantTimeEquals(sign(options.secret, body), signature)) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      return false;
    }
    const expiresAt = (parsed as Record<string, unknown>)["expiresAt"];
    return typeof expiresAt === "number" && expiresAt > options.nowSeconds;
  } catch {
    return false;
  }
};

/**
 * Reads one cookie without a parser dependency.
 *
 * Express 5 does not parse cookies itself, and `cookie-parser` would be a dependency for one header.
 * Splitting on `;` and taking the first match is correct for a single `HttpOnly` cookie we set
 * ourselves; it is not a general-purpose parser and is not used as one.
 */
const readCookie = (request: Request, name: string): string | undefined => {
  const header = request.headers.cookie;
  if (typeof header !== "string") {
    return undefined;
  }
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq > 0 && trimmed.slice(0, eq) === name) {
      return decodeURIComponent(trimmed.slice(eq + 1));
    }
  }
  return undefined;
};
