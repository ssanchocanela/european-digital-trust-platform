import { type Clock, PlatformError } from "@edtp/shared";

/**
 * Typed HTTP client for the wrapped engine.
 *
 * Hand-written rather than generated from the engine's SDK, so an engine release is
 * never a compile-time event for the platform — ADR 0001. Every route and payload here
 * was verified against EUDIPLO v7.6.0 source at commit `3b2a9e7`, not against its
 * prose documentation, which diverges in at least seven places
 * (`docs/interop-findings.md` section A).
 */

/** Credentials for one engine tenant, which serves one Relying Party Instance. */
export interface EngineTenantCredentials {
  readonly engineTenantRef: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface EngineCredentialResolver {
  resolve(engineTenantRef: string): Promise<EngineTenantCredentials>;
}

export interface EngineClientOptions {
  readonly baseUrl: string;
  readonly credentials: EngineCredentialResolver;
  readonly clock: Clock;
  readonly requestTimeoutMs?: number;
  readonly maxRetries?: number;
  /** Injected in tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
}

interface CachedToken {
  readonly accessToken: string;
  readonly expiresAt: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 2;
/** Refresh a little before expiry so a long request cannot straddle the boundary. */
const TOKEN_SKEW_MS = 30_000;

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Only methods that are safe to repeat are retried. */
const isIdempotent = (method: Method): boolean =>
  method === "GET" || method === "PUT" || method === "DELETE";

export class EngineClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly tokens = new Map<string, CachedToken>();

  constructor(private readonly options: EngineClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  /** `GET /health`. Used by the platform health endpoint and the adapter suite. */
  async health(): Promise<boolean> {
    try {
      const res = await this.rawFetch("GET", "/health", undefined, undefined);
      return res.ok;
    } catch {
      return false;
    }
  }

  async request<T>(
    engineTenantRef: string,
    method: Method,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const token = await this.accessToken(engineTenantRef);
    let lastError: unknown;

    const attempts = isIdempotent(method) ? this.maxRetries + 1 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) {
        // Bounded exponential backoff with jitter, so a transient engine blip does
        // not turn into a synchronised retry storm.
        const delay = Math.min(250 * 2 ** (attempt - 1), 2_000);
        await new Promise((r) => setTimeout(r, delay + Math.floor(Math.random() * 100)));
      }
      try {
        const res = await this.rawFetch(method, path, body, token);
        if (res.status === 401 || res.status === 403) {
          // The cached token may have been revoked. Drop it so the next call re-auths,
          // but do not retry here: a genuine authorisation failure must surface.
          this.tokens.delete(engineTenantRef);
          throw PlatformError.engine(
            "engine_unauthorised",
            "The platform could not authenticate to the verification engine.",
          );
        }
        if (res.status >= 500) {
          lastError = PlatformError.engine(
            "engine_unavailable",
            "The verification engine returned a server error.",
          );
          continue;
        }
        if (!res.ok) {
          throw await this.toEngineError(res);
        }
        if (res.status === 204) return undefined as T;
        const text = await res.text();
        return (text.length === 0 ? undefined : JSON.parse(text)) as T;
      } catch (error) {
        if (error instanceof PlatformError && error.code !== "engine_unavailable") throw error;
        lastError = error;
      }
    }

    if (lastError instanceof PlatformError) throw lastError;
    throw PlatformError.engine(
      "engine_unreachable",
      "The verification engine could not be reached.",
    );
  }

  private async rawFetch(
    method: Method,
    path: string,
    body: unknown,
    token: string | undefined,
  ): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";

    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      const timedOut = cause instanceof Error && cause.name === "TimeoutError";
      throw PlatformError.engine(
        timedOut ? "engine_timeout" : "engine_unavailable",
        timedOut
          ? "The verification engine did not respond in time."
          : "The verification engine could not be reached.",
      );
    }
  }

  /**
   * Normalises an engine error response.
   *
   * The engine returns `{statusCode, timestamp, path, error, message}` for verification
   * failures, where `error` is a stable code. Only the code and the short message are
   * carried forward; the engine deliberately keeps verbose diagnostics (certificate
   * subjects, thumbprints, configured list URLs) out of its response, and the platform
   * must not reintroduce them.
   */
  private async toEngineError(res: Response): Promise<PlatformError> {
    let code = `engine_http_${res.status}`;
    let message = "The verification engine rejected the request.";
    try {
      const payload = (await res.json()) as { error?: unknown; message?: unknown };
      if (typeof payload.error === "string" && payload.error.length > 0) code = payload.error;
      if (typeof payload.message === "string" && payload.message.length > 0) {
        message = payload.message;
      }
    } catch {
      // A non-JSON error body carries nothing safe to surface.
    }
    return PlatformError.engine(code, message);
  }

  private async accessToken(engineTenantRef: string): Promise<string> {
    const now = this.options.clock.now().getTime();
    const cached = this.tokens.get(engineTenantRef);
    if (cached && cached.expiresAt - TOKEN_SKEW_MS > now) return cached.accessToken;

    const creds = await this.options.credentials.resolve(engineTenantRef);
    const res = await this.rawFetch(
      "POST",
      "/api/oauth2/token",
      {
        grant_type: "client_credentials",
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
      },
      undefined,
    );
    if (!res.ok) {
      throw PlatformError.engine(
        "engine_authentication_failed",
        "The platform could not obtain a token from the verification engine.",
      );
    }
    const payload = (await res.json()) as {
      access_token?: unknown;
      expires_in?: unknown;
    };
    if (typeof payload.access_token !== "string") {
      throw PlatformError.engine(
        "engine_authentication_malformed",
        "The verification engine returned a malformed token response.",
      );
    }
    const expiresInSeconds = typeof payload.expires_in === "number" ? payload.expires_in : 3600;
    this.tokens.set(engineTenantRef, {
      accessToken: payload.access_token,
      expiresAt: now + expiresInSeconds * 1000,
    });
    return payload.access_token;
  }

  /** Clears cached tokens. Used between tests and on credential rotation. */
  resetTokens(): void {
    this.tokens.clear();
  }
}
