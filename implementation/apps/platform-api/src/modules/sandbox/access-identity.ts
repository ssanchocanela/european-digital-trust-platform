import { createPublicKey, type KeyObject, verify } from "node:crypto";
import { normaliseEmail } from "@edtp/sandbox-domain";
import { type Clock, PlatformError } from "@edtp/shared";
import type { Logger } from "../../logging/logger.js";

/**
 * Who Cloudflare Access says is at the portal (ADR 0018 Decision 1).
 *
 * Access puts a signed assertion on every request it lets through, `Cf-Access-Jwt-Assertion`; the
 * portal forwards it, and this checks it — here, in the platform, so that the portal's shared secret
 * alone cannot mint an identity. The unsigned `cf-access-authenticated-user-email` header is never
 * read: one hostname routed around Access would make it a sign-in-as-anyone.
 */
export interface AccessIdentity {
  /** Normalised: trimmed, lower-cased. Personal data — never logged. */
  readonly email: string;
}

export interface AccessIdentityVerifier {
  /** The identity in the assertion, or `unauthenticated`. */
  verify(assertion: string | undefined): Promise<AccessIdentity>;
}

/** The header the portal forwards Access's assertion in. */
export const SANDBOX_ACCESS_ASSERTION_HEADER = "x-edtp-sandbox-access-assertion";

const CLOCK_SKEW_S = 60;
/** Refetch the key set at most this often when an assertion names an unknown key. */
const REFETCH_FLOOR_MS = 60_000;
/** And refresh it on this period regardless, so a rotated-out key stops being accepted. */
const KEYS_MAX_AGE_MS = 6 * 60 * 60 * 1000;

const b64url = (part: string) => Buffer.from(part, "base64url");

function decodeJson(part: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(b64url(part).toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The Cloudflare Access verifier. RS256 only; `iss` must be the team domain, `aud` must contain the
 * portal application's audience tag, `exp`/`nbf` are honoured with a minute of skew, and the token
 * must carry an `email`. Keys come from `https://<team>/cdn-cgi/access/certs` and are cached.
 */
export class CloudflareAccessVerifier implements AccessIdentityVerifier {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = 0;
  private inFlight: Promise<void> | undefined;
  private readonly issuer: string;

  constructor(
    teamDomain: string,
    private readonly audience: string,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const host = teamDomain.replace(/^https:\/\//, "").replace(/\/+$/, "");
    this.issuer = `https://${host}`;
  }

  private async refresh(): Promise<void> {
    this.inFlight ??= (async () => {
      try {
        const response = await this.fetchImpl(`${this.issuer}/cdn-cgi/access/certs`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as { keys?: unknown };
        const next = new Map<string, KeyObject>();
        for (const jwk of Array.isArray(body.keys) ? body.keys : []) {
          const k = jwk as Record<string, unknown>;
          if (k.kty !== "RSA" || typeof k.kid !== "string") continue;
          next.set(k.kid, createPublicKey({ key: k as never, format: "jwk" }));
        }
        if (next.size === 0) throw new Error("no RSA keys");
        this.keys = next;
        this.fetchedAt = this.clock.now().getTime();
      } catch (error) {
        // An outage, not a bad assertion: logged, and the request is refused below.
        this.logger.warn("sandbox access keys could not be fetched", {
          errorName: error instanceof Error ? error.name : "unknown",
        });
      } finally {
        this.inFlight = undefined;
      }
    })();
    return this.inFlight;
  }

  private async keyFor(kid: string): Promise<KeyObject | undefined> {
    const age = this.clock.now().getTime() - this.fetchedAt;
    if (age > KEYS_MAX_AGE_MS || (!this.keys.has(kid) && age > REFETCH_FLOOR_MS)) {
      await this.refresh();
    }
    return this.keys.get(kid);
  }

  async verify(assertion: string | undefined): Promise<AccessIdentity> {
    const refuse = (reason: string): never => {
      this.logger.info("sandbox access assertion refused", { reason });
      throw PlatformError.unauthenticated();
    };
    if (!assertion || assertion.length > 8192) return refuse("missing");
    const parts = assertion.split(".");
    if (parts.length !== 3) return refuse("malformed");
    const [h, p, sig] = parts as [string, string, string];
    const header = decodeJson(h);
    const claims = decodeJson(p);
    if (!header || !claims) return refuse("malformed");
    if (header.alg !== "RS256" || typeof header.kid !== "string") return refuse("algorithm");
    const key = await this.keyFor(header.kid);
    if (!key) return refuse("unknown_key");
    if (!verify("sha256", Buffer.from(`${h}.${p}`), key, b64url(sig)))
      return refuse("signature");
    if (claims.iss !== this.issuer) return refuse("issuer");
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(this.audience)) return refuse("audience");
    const now = this.clock.now().getTime() / 1000;
    if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_S <= now) {
      return refuse("expired");
    }
    if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_S > now) {
      return refuse("not_yet_valid");
    }
    const email = typeof claims.email === "string" ? normaliseEmail(claims.email) : undefined;
    if (!email) return refuse("no_email");
    return { email };
  }
}

/**
 * A laptop without Access (ADR 0018 Decision 7): one fixed address, no assertion. The configuration
 * refuses it together with the Access settings, so it cannot run beside the real check.
 */
export class DevelopmentAccessIdentity implements AccessIdentityVerifier {
  private readonly email: string;

  constructor(raw: string) {
    const email = normaliseEmail(raw);
    if (!email) throw new Error("SANDBOX_ACCESS_DEV_IDENTITY must be an e-mail address");
    this.email = email;
  }

  async verify(): Promise<AccessIdentity> {
    return { email: this.email };
  }
}
