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

/**
 * One entry in the policy picker.
 *
 * `relyingPartyServiceName` and `publishedVersion` are the two fields that make a list worth more
 * than a text box, and they are why the API's list route grew a join — see the note on
 * `ListingRepository.presentationPolicies`.
 */
export interface PolicyOption {
  readonly id: string;
  readonly name: string;
  readonly relyingPartyServiceName: string;
  /** `null` when the policy has no published version and therefore cannot start a transaction. */
  readonly publishedVersion: number | null;
  /** The container's own lifecycle: `ACTIVE` or `RETIRED`. */
  readonly status: string;
}

/** A Relying Party Service, as the offer builder needs it. */
export interface ServiceOption {
  readonly id: string;
  readonly name: string;
  readonly serviceIdentifier: string;
}

/**
 * One credential a Relying Party has **registered** for an intended use, with the claims it
 * registered for it.
 *
 * This is what the offer builder offers, and the reason it does not offer anything else: a policy is
 * validated against the intended use at publication, and asking for a claim outside the registered
 * set is refused. Building the screen from the registration makes that impossible rather than
 * explaining it after a 422.
 */
export interface RegisteredCredential {
  readonly format: string;
  readonly vctValues?: readonly string[];
  readonly doctype?: string;
  readonly claims: readonly (readonly (string | number | null)[])[];
}

export interface IntendedUseOption {
  readonly id: string;
  readonly identifier: string;
  readonly registeredCredentials: readonly RegisteredCredential[];
}

/** A presentation in a list. Metadata only — the API never returns a result in a list. */
export interface PresentationSummary {
  readonly presentationId: string;
  readonly businessReference: string;
  readonly status: string;
  readonly policyId: string;
  readonly interactionType: string;
  readonly failureCode?: string;
  readonly createdAt: string;
  readonly closedAt?: string;
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

  /**
   * The policies this credential may start a transaction with.
   *
   * Two calls, because the list route is tenant-scoped in its path and the console is told its own
   * tenant by the API rather than by configuration — a configured id can drift out of step with the
   * key it sits beside, and the resulting `403` reads as an authentication failure rather than as
   * the mismatch it is.
   *
   * One page. A picker that needs a second page is a picker that should have been a search, and
   * pretending otherwise by silently showing the first page of many is worse than the text box it
   * replaces. The caller is told when there are more.
   */
  async listPresentationPolicies(): Promise<{
    readonly options: readonly PolicyOption[];
    readonly truncated: boolean;
  }> {
    const { tenantId } = await this.call<{ tenantId: string }>("GET", "/v1/me");
    const page = await this.call<{
      items: readonly {
        id: string;
        name: string;
        detail?: Record<string, unknown>;
      }[];
      nextCursor?: string;
    }>("GET", `/v1/tenants/${encodeURIComponent(tenantId)}/presentation-policies?limit=100`);

    return {
      options: page.items.map((item) => ({
        id: item.id,
        name: item.name,
        relyingPartyServiceName: String(
          item.detail?.relyingPartyServiceName ?? "unknown service",
        ),
        publishedVersion:
          typeof item.detail?.publishedVersion === "number"
            ? item.detail.publishedVersion
            : null,
        status: String(item.detail?.status ?? "unknown"),
      })),
      truncated: page.nextCursor !== undefined,
    };
  }

  /** The Relying Party Services an offer can be defined under. */
  async listServices(): Promise<readonly ServiceOption[]> {
    const { tenantId } = await this.call<{ tenantId: string }>("GET", "/v1/me");
    const page = await this.call<{
      items: readonly { id: string; name: string; detail?: Record<string, unknown> }[];
    }>("GET", `/v1/tenants/${encodeURIComponent(tenantId)}/rp-services?limit=100`);
    return page.items.map((i) => ({
      id: i.id,
      name: i.name,
      serviceIdentifier: String(i.detail?.serviceIdentifier ?? ""),
    }));
  }

  /** What one Service has registered, which bounds what an offer may ask for. */
  async listIntendedUses(serviceId: string): Promise<readonly IntendedUseOption[]> {
    const { tenantId } = await this.call<{ tenantId: string }>("GET", "/v1/me");
    const page = await this.call<{
      items: readonly { id: string; name: string; detail?: Record<string, unknown> }[];
    }>(
      "GET",
      `/v1/tenants/${encodeURIComponent(tenantId)}/rp-services/${encodeURIComponent(serviceId)}` +
        "/intended-uses?limit=100",
    );
    return page.items.map((i) => ({
      id: i.id,
      identifier: i.name,
      registeredCredentials: Array.isArray(i.detail?.registeredCredentials)
        ? (i.detail.registeredCredentials as RegisteredCredential[])
        : [],
    }));
  }

  /**
   * Defines an offer: the policy, then its first version, published.
   *
   * Two calls because that is the API's shape, and the shape is deliberate — a policy is a container
   * and a version is immutable once published. The console does both in one action because a policy
   * with no published version cannot be used for anything, and leaving one behind is how the picker
   * fills with entries that do not work.
   */
  async createOffer(input: {
    readonly relyingPartyServiceId: string;
    readonly intendedUseId: string;
    readonly name: string;
    readonly description: string;
    readonly purpose: string;
    readonly credentialType: string;
    readonly acceptedFormats: readonly string[];
    readonly requestedClaims: readonly (readonly (string | number | null)[])[];
    readonly resultPolicy: Record<string, unknown>;
  }): Promise<{ readonly policyId: string }> {
    const { tenantId } = await this.call<{ tenantId: string }>("GET", "/v1/me");
    const base = `/v1/tenants/${encodeURIComponent(tenantId)}/presentation-policies`;

    const created = await this.call<{ policyId: string }>("POST", base, {
      relyingPartyServiceId: input.relyingPartyServiceId,
      intendedUseId: input.intendedUseId,
      name: input.name,
      description: input.description,
    });

    await this.call("POST", `${base}/${encodeURIComponent(created.policyId)}/versions`, {
      purpose: [{ lang: "en", value: input.purpose }],
      credentialRequirements: [
        { credentialType: input.credentialType, acceptedFormats: input.acceptedFormats },
      ],
      requestedClaims: input.requestedClaims.map((path) => ({ path })),
      resultPolicy: input.resultPolicy,
      publish: true,
    });

    return { policyId: created.policyId };
  }

  /**
   * Presentations, optionally narrowed to one offer.
   *
   * Narrowed by the API, not here. A page filtered after it is read comes back short, and a short
   * page is indistinguishable from the end of the list.
   */
  async listPresentations(policyId?: string): Promise<readonly PresentationSummary[]> {
    const query = policyId
      ? `?limit=100&policyId=${encodeURIComponent(policyId)}`
      : "?limit=100";
    const page = await this.call<{ items: readonly PresentationSummary[] }>(
      "GET",
      `/v1/presentations${query}`,
    );
    return page.items;
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
