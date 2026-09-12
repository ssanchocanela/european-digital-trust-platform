/**
 * The console's only way to reach the platform.
 *
 * ## Named actions, not a proxy
 *
 * Every method here is a specific operation. There is deliberately **no** `request(path, method, body)`
 * helper exposed to the routes, because that is how a back-office console becomes an open relay: one
 * screen that forwards a path from a query parameter, and the console's tenant key is usable for
 * anything the API offers.
 *
 * ## The console is just another API client
 *
 * It has no privileged view. What it renders is what the API returns — `docs/web-interface-proposal.md`
 * §3.1. If a screen needs more, the API's contract changes; the console does not reach around it.
 */

/** What `POST /v1/presentations` answers. */
export interface CreatedPresentation {
  readonly presentationId: string;
  readonly status: string;
  readonly interaction?: { readonly type: string; readonly uri: string };
  readonly expiresAt: string;
  readonly warnings?: readonly { readonly code: string; readonly message: string }[];
}

/** What `GET /v1/presentations/{id}` answers. Result content is whatever the result policy emitted. */
export interface PresentationView {
  readonly presentationId: string;
  readonly businessReference: string;
  readonly status: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly expiresAt: string;
  readonly result?: { readonly claims: Readonly<Record<string, unknown>> };
  readonly failureCode?: string;
  readonly warnings?: readonly { readonly code: string; readonly message: string }[];
}

export interface PlatformHealth {
  readonly status: string;
  readonly engine: string;
}

export class PlatformApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PlatformApiError";
  }
}

export class PlatformClient {
  constructor(
    private readonly baseUrl: string,
    private readonly tenantApiKey: string,
    private readonly timeoutMs: number,
  ) {}

  async createPresentation(input: {
    policyId: string;
    policyVersion?: number;
    businessReference: string;
    interactionType: "SAME_DEVICE" | "QR";
  }): Promise<CreatedPresentation> {
    return this.call<CreatedPresentation>("POST", "/v1/presentations", {
      policyId: input.policyId,
      ...(input.policyVersion !== undefined ? { policyVersion: input.policyVersion } : {}),
      businessReference: input.businessReference,
      interactionType: input.interactionType,
    });
  }

  async readPresentation(presentationId: string): Promise<PresentationView> {
    // The id goes in a path segment, encoded. Never a query string: `docs/web-interface-proposal.md`
    // §3.1 keeps transaction identifiers out of URLs that browsers keep in history and send in
    // `Referer`.
    return this.call<PresentationView>(
      "GET",
      `/v1/presentations/${encodeURIComponent(presentationId)}`,
    );
  }

  async health(): Promise<PlatformHealth> {
    return this.call<PlatformHealth>("GET", "/health");
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(new URL(path, this.baseUrl), {
        method,
        headers: {
          // The key lives here and only here. It is never rendered, never logged, never set as a
          // cookie, and never forwarded to the browser.
          authorization: `Bearer ${this.tenantApiKey}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });

      const text = await response.text();
      if (!response.ok) {
        throw new PlatformApiError(
          response.status,
          errorCodeOf(text),
          errorMessageOf(text, response),
        );
      }
      return (text.length > 0 ? JSON.parse(text) : {}) as T;
    } catch (error) {
      if (error instanceof PlatformApiError) {
        throw error;
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw new PlatformApiError(
          504,
          "platform_api_timeout",
          "The platform API did not respond.",
        );
      }
      throw new PlatformApiError(
        502,
        "platform_api_unreachable",
        "The platform API could not be reached.",
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * The platform's error envelope is `{error: {code, message}}`. Parsed defensively: a console that
 * throws while rendering an error page is worse than one that shows a generic message.
 */
const parseEnvelope = (text: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      const error = (parsed as Record<string, unknown>)["error"];
      if (typeof error === "object" && error !== null) {
        return error as Record<string, unknown>;
      }
    }
  } catch {
    /* fall through to the generic message */
  }
  return undefined;
};

const errorCodeOf = (text: string): string => {
  const code = parseEnvelope(text)?.["code"];
  return typeof code === "string" ? code : "platform_api_error";
};

const errorMessageOf = (text: string, response: Response): string => {
  const message = parseEnvelope(text)?.["message"];
  // The API's own message, when it gave one. Never the raw body: it could carry anything, and this
  // string is rendered.
  return typeof message === "string"
    ? message
    : `The platform API answered ${response.status} ${response.statusText}.`;
};
