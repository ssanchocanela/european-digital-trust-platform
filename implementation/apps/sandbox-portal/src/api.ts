/**
 * The portal's client for the platform's `/sandbox/v1` routes. The portal holds the portal secret;
 * a person's session token and Cloudflare Access's assertion each travel in their own header and
 * nowhere else. The platform validates the assertion (ADR 0018).
 */
export interface ApiResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

export interface SandboxApi {
  call(
    method: "GET" | "POST" | "DELETE",
    path: string,
    options?: { session?: string; assertion?: string; body?: unknown },
  ): Promise<ApiResult>;
}

export function httpApi(
  baseUrl: string,
  portalSecret: string,
  fetchImpl: typeof fetch = fetch,
): SandboxApi {
  return {
    async call(method, path, options = {}) {
      const headers: Record<string, string> = {
        accept: "application/json",
        "x-edtp-sandbox-portal-secret": portalSecret,
      };
      if (options.session) headers["x-edtp-sandbox-session"] = options.session;
      if (options.assertion) headers["x-edtp-sandbox-access-assertion"] = options.assertion;
      if (options.body !== undefined) headers["content-type"] = "application/json";
      const response = await fetchImpl(
        new URL(`sandbox/v1/${path}`, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`),
        {
          method,
          headers,
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
          signal: AbortSignal.timeout(10_000),
        },
      );
      const text = await response.text();
      let body: Record<string, unknown> = {};
      try {
        body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        body = {};
      }
      return { status: response.status, body };
    },
  };
}
