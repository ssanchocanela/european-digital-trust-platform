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

/** An issuance policy in a list: what it issues, and whether it can. */
export type ClaimValueType = "string" | "number" | "boolean" | "date" | "string[]";

export interface OperatorFormField {
  /** Dotted, as the API's `subjectAttributes` accepts it. */
  readonly path: string;
  readonly label: string;
  readonly valueType: ClaimValueType;
  readonly mandatory: boolean;
}

export interface OperatorForm {
  readonly fields: readonly OperatorFormField[];
  /** Set by the policy, shown so the operator knows what the credential will say. */
  readonly fixed: readonly { readonly label: string; readonly value: string }[];
}

export interface IssuanceOption {
  readonly id: string;
  readonly name: string;
  readonly credentialTypeName: string;
  readonly credentialFormat: string;
  readonly publishedVersion: number | null;
  readonly status: string;
}

/** An issuance transaction. Metadata only, like every list. */
export interface IssuanceSummary {
  readonly issuanceId: string;
  readonly businessReference?: string;
  readonly status: string;
  readonly policyId: string;
  readonly failureCode?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/** An attestation that was actually collected, and what its status is now. */
export interface IssuedCredentialSummary {
  readonly issuedCredentialId: string;
  readonly credentialTypeId: string;
  readonly status: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly statusChangedAt?: string;
  /**
   * Whether the engine acknowledged this status.
   *
   * Optional here only because an older API would not send it; absent is treated as confirmed, so
   * the console never invents a warning. `false` is the case that matters: the platform intends the
   * status and the status list a Relying Party reads may not carry it.
   */
  readonly statusConfirmed?: boolean;
}

/**
 * What a Wallet would find when it tries to authenticate the provider — ARF §6.6.2.2, trust gate (a).
 *
 * Read and shown rather than assumed, because the answer today is "it cannot", and a console that
 * quietly omitted it would let an operator believe issuance is ready when no wallet can complete it.
 */
/** Whether one certificate still works. `notAfter: null` means unrecorded, not healthy. */
export interface CertificateValidity {
  readonly notAfter: string | null;
  readonly expired: boolean | null;
}

export interface ProviderAuthentication {
  readonly metadataSigned?: boolean;
  readonly walletCanAuthenticateProvider?: boolean;
  /**
   * The route's own field name.
   *
   * It was read as `registrationCertificatePublished` here until 16 September 2026 — a name the
   * route has never sent, so the row rendered from it was always `no`. It happened to be right,
   * because V0 has no registration certificate (B3), which is exactly what made it invisible. The
   * sixth time on this project that a response shape was assumed rather than read.
   */
  readonly registrationCertificatePresent?: boolean;
  /** Whether the provider can sign at all — separate from whether a Wallet can authenticate it. */
  readonly canSignAttestations?: boolean;
  readonly certificates?: {
    readonly attestationSigning?: CertificateValidity;
    readonly access?: CertificateValidity;
  };
  readonly error?: string;
  readonly message?: string;
}

/**
 * An authentic source this deployment has registered.
 *
 * `sampleSubjectReferences` is present only for a **fixture**. A real source never lists its
 * subject references — they identify real people, and a list of them is a directory.
 */
export interface AuthenticSourceOption {
  readonly name: string;
  readonly kind: string;
  readonly sampleSubjectReferences?: readonly string[];
}

/** One recorded step of a presentation. Evidence, never content. */
export interface AuditEvent {
  readonly at: string;
  readonly action: string;
  readonly actor?: string;
  readonly outcome?: string;
  readonly correlationId?: string;
  readonly detail?: Readonly<Record<string, unknown>>;
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

  /** Which tenant this credential belongs to. */
  async whoAmI(): Promise<{ readonly tenantId: string }> {
    return this.call<{ tenantId: string }>("GET", "/v1/me");
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
    readonly anchorSources: readonly {
      readonly kind: string;
      readonly domain: string;
      readonly ref: string;
    }[];
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
      trustPolicy: { anchorSources: input.anchorSources },
      publish: true,
    });

    return { policyId: created.policyId };
  }

  /** The lists of trusted attestation issuers this deployment has loaded, by published URL. */
  async issuerTrustSources(): Promise<readonly string[]> {
    const { tenantId } = await this.call<{ tenantId: string }>("GET", "/v1/me");
    const capabilities = await this.call<{ issuerTrustSources: readonly { ref: string }[] }>(
      "GET",
      `/v1/tenants/${encodeURIComponent(tenantId)}/verification-capabilities`,
    );
    return capabilities.issuerTrustSources.map((source) => source.ref);
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

  /** The issuance policies this tenant operates. */
  async listIssuancePolicies(): Promise<readonly IssuanceOption[]> {
    const { tenantId } = await this.call<{ tenantId: string }>("GET", "/v1/me");
    const page = await this.call<{
      items: readonly { id: string; name: string; detail?: Record<string, unknown> }[];
    }>("GET", `/v1/tenants/${encodeURIComponent(tenantId)}/issuance-policies?limit=100`);
    return page.items.map((i) => ({
      id: i.id,
      name: i.name,
      credentialTypeName: String(i.detail?.credentialTypeName ?? "unknown"),
      credentialFormat: String(i.detail?.credentialFormat ?? ""),
      publishedVersion:
        typeof i.detail?.publishedVersion === "number" ? i.detail.publishedVersion : null,
      status: String(i.detail?.status ?? "unknown"),
    }));
  }

  /** Issuances, optionally narrowed to one policy — narrowed by the API, not here. */
  async listIssuances(policyId?: string): Promise<readonly IssuanceSummary[]> {
    const query = policyId
      ? `?limit=100&policyId=${encodeURIComponent(policyId)}`
      : "?limit=100";
    const page = await this.call<{ items: readonly IssuanceSummary[] }>(
      "GET",
      `/v1/issuances${query}`,
    );
    return page.items;
  }

  async listIssuedCredentials(): Promise<readonly IssuedCredentialSummary[]> {
    const page = await this.call<{ items: readonly IssuedCredentialSummary[] }>(
      "GET",
      "/v1/issued-credentials?limit=100",
    );
    return page.items;
  }

  /** Starts an issuance and returns the offer for a wallet. */
  /**
   * Creates a credential offer.
   *
   * The wallet-facing URI arrives as **`interaction`**, the same field name the verification side
   * uses — not `offer`. This read it as `offer` until 16 September 2026, so `created.offer` was
   * always `undefined` and the console had **never once displayed a credential offer**: the button
   * created the transaction and the screen then said "No offer open". The one capability the
   * issuance console exists for, silently absent, because nobody read the route's answer.
   *
   * The seventh time on this project. The others: A18, A24, the console's error envelope, the audit
   * envelope, the service-instance field, and `registrationCertificatePublished` on the gate panel.
   */
  async createIssuance(input: {
    readonly policyId: string;
    readonly subjectReference: string;
    readonly businessReference: string;
    /** Only for an `operator-form` policy. Content: sent once, never kept or logged here. */
    readonly subjectAttributes?: Readonly<Record<string, unknown>>;
  }): Promise<{
    readonly issuanceId: string;
    readonly status: string;
    readonly interaction?: { readonly type: string; readonly uri: string };
    readonly expiresAt: string;
    readonly warnings?: readonly string[];
  }> {
    return this.call("POST", "/v1/issuances", input);
  }

  /**
   * Changes an issued attestation's status.
   *
   * Revocation is irreversible in the platform — `AS-AP-07-007` (`VCR_04`) — so the console offers
   * revoke and suspend, and reinstatement only from suspended. The API enforces it; the screen
   * simply does not offer the move it would refuse.
   */
  async changeCredentialStatus(
    issuedCredentialId: string,
    status: "REVOKED" | "SUSPENDED" | "VALID",
  ): Promise<unknown> {
    const path = `/v1/issued-credentials/${encodeURIComponent(issuedCredentialId)}`;
    return status === "REVOKED"
      ? this.call("POST", `${path}/revoke`, {})
      : this.call("POST", `${path}/status`, { status });
  }

  /** Trust gate (a), as a Wallet would find it. Never fabricated when it cannot be read. */
  async providerAuthentication(providerId: string): Promise<ProviderAuthentication> {
    const { tenantId } = await this.call<{ tenantId: string }>("GET", "/v1/me");
    return this.call<ProviderAuthentication>(
      "GET",
      `/v1/tenants/${encodeURIComponent(tenantId)}/attestation-providers/` +
        `${encodeURIComponent(providerId)}/provider-authentication`,
    );
  }

  /** The Attestation Providers this tenant operates. */
  async listAttestationProviders(): Promise<readonly { id: string; name: string }[]> {
    const { tenantId } = await this.call<{ tenantId: string }>("GET", "/v1/me");
    const page = await this.call<{ items: readonly { id: string; name: string }[] }>(
      "GET",
      `/v1/tenants/${encodeURIComponent(tenantId)}/attestation-providers?limit=100`,
    );
    return page.items;
  }

  /**
   * Defines what this tenant issues: a credential type, a policy over it, and a published version.
   *
   * Three calls, in that order, because they are three business objects and the platform models
   * them separately — the type says what the attestation *is*, the policy who may receive one and
   * where its values come from, and the version makes a particular answer immutable.
   *
   * There is no partial success worth reporting to an operator: a credential type with no policy is
   * invisible on every screen, so a failure at step two or three surfaces as the failure it is and
   * the type is left behind rather than deleted. Deleting it would be worse — it may be the one
   * thing that succeeded, and the routes to remove it do not exist.
   */
  async defineIssuance(input: {
    readonly attestationProviderId: string;
    readonly name: string;
    readonly format: "dc+sd-jwt" | "mso_mdoc";
    readonly typeIdentifier: string;
    readonly rulebookIdentifier: string;
    readonly rulebookVersion: string;
    readonly claims: readonly {
      readonly path: readonly string[];
      readonly label: string;
      readonly valueType: "string" | "number" | "boolean" | "date";
      readonly mandatory: boolean;
    }[];
    readonly validitySeconds: number;
    readonly statusMechanism: "TOKEN_STATUS_LIST" | "NONE";
    readonly purpose: string;
    readonly evaluator: string;
    readonly evaluatorParameters: Readonly<Record<string, unknown>>;
    readonly connector: string;
    /** Only the parameters the chosen source declares. Empty for the fixture. */
    readonly connectorParameters: Readonly<Record<string, unknown>>;
    readonly flow: "PRE_AUTHORIZED_CODE" | "AUTHORIZATION_CODE";
    readonly holderBinding: "KEY_BOUND" | "BEARER";
    readonly suspensionAllowed: boolean;
  }): Promise<{ readonly policyId: string }> {
    const { tenantId } = await this.call<{ tenantId: string }>("GET", "/v1/me");
    const base = `/v1/tenants/${encodeURIComponent(tenantId)}`;

    const type = await this.call<{ credentialTypeId: string }>(
      "POST",
      `${base}/credential-types`,
      {
        attestationProviderId: input.attestationProviderId,
        name: input.name,
        format: input.format,
        // `vct` for SD-JWT VC, `doctype` for mdoc. The same box on the form, because to an operator
        // it is one question — what this credential is called in the protocol.
        ...(input.format === "dc+sd-jwt"
          ? { vct: input.typeIdentifier }
          : { doctype: input.typeIdentifier }),
        rulebook: {
          identifier: input.rulebookIdentifier,
          version: input.rulebookVersion,
          // Trust configuration, not a label: ARF §6.3.2.4 makes the Rulebook the source of anchors
          // for verifying this attestation's signature. The console does not offer the other value,
          // because publishing a list is a deliberate act with its own consequences.
          anchorSource: "RULEBOOK_ONLY",
        },
        claims: input.claims.map((c) => ({
          path: c.path,
          display: [{ lang: "en", value: c.label }],
          mandatory: c.mandatory,
          valueType: c.valueType,
        })),
        display: [{ lang: "en", value: input.name }],
        validitySeconds: input.validitySeconds,
        statusMechanism: input.statusMechanism,
        requiresKeyBinding: input.holderBinding === "KEY_BOUND",
      },
    );

    const policy = await this.call<{ policyId: string }>("POST", `${base}/issuance-policies`, {
      credentialTypeId: type.credentialTypeId,
      name: input.name,
    });

    await this.call(
      "POST",
      `${base}/issuance-policies/${encodeURIComponent(policy.policyId)}/versions`,
      {
        credentialTypeId: type.credentialTypeId,
        purpose: [{ lang: "en", value: input.purpose }],
        eligibilityRule: { evaluator: input.evaluator, parameters: input.evaluatorParameters },
        authenticSource: { connector: input.connector, parameters: input.connectorParameters },
        holderBinding: input.holderBinding,
        flow: input.flow,
        credentialValiditySeconds: input.validitySeconds,
        statusPolicy: {
          // Must agree with the credential type: a policy that promises revocation over a type with
          // no status mechanism is refused at publication, and rightly.
          statusListEnabled: input.statusMechanism === "TOKEN_STATUS_LIST",
          suspensionAllowed: input.suspensionAllowed,
        },
        publish: true,
      },
    );

    return { policyId: policy.policyId };
  }

  /**
   * Retires an issuance policy, or brings a retired one back.
   *
   * Reversible, unlike revoking an attestation: retiring stops new issuances starting and changes
   * nothing about attestations already issued.
   */
  async setIssuancePolicyStatus(policyId: string, status: "ACTIVE" | "RETIRED"): Promise<void> {
    const { tenantId } = await this.call<{ tenantId: string }>("GET", "/v1/me");
    await this.call(
      "POST",
      `/v1/tenants/${encodeURIComponent(tenantId)}/issuance-policies/` +
        `${encodeURIComponent(policyId)}/status`,
      { status },
    );
  }

  /**
   * The authentic source a policy's latest published version reads from, or `undefined`.
   *
   * Read from the policy detail the API returns, not inferred from the policy name: two policies can
   * issue the same credential type from different sources, and only one of them can be issued from a
   * presentation.
   */
  /**
   * The attributes an operator types for an `operator-form` policy, or `undefined` for any other.
   *
   * Built from the credential type rather than written per credential, so the test PID's form is
   * whatever its type declares. Claims the policy fixes are returned separately and shown read-only:
   * the API refuses a supplied value for one, so offering the box would only produce an error.
   */
  async operatorFormFields(policyId: string): Promise<OperatorForm | undefined> {
    const { tenantId } = await this.call<{ tenantId: string }>("GET", "/v1/me");
    const base = `/v1/tenants/${encodeURIComponent(tenantId)}`;
    const detail = await this.call<{
      versions?: readonly {
        readonly version: number;
        readonly status: string;
        readonly credentialTypeId: string;
        readonly authenticSource?: {
          readonly connector?: string;
          readonly parameters?: { readonly fixedClaims?: Readonly<Record<string, unknown>> };
        };
      }[];
    }>("GET", `${base}/issuance-policies/${encodeURIComponent(policyId)}`);
    const published = (detail.versions ?? [])
      .filter((v) => v.status === "PUBLISHED")
      .sort((a, b) => b.version - a.version)[0];
    if (published?.authenticSource?.connector !== "operator-form") return undefined;

    const type = await this.call<{
      readonly claims: readonly {
        readonly path: readonly string[];
        readonly display: readonly { readonly lang: string; readonly value: string }[];
        readonly mandatory: boolean;
        readonly valueType: ClaimValueType;
      }[];
    }>("GET", `${base}/credential-types/${encodeURIComponent(published.credentialTypeId)}`);

    const fixedClaims = published.authenticSource.parameters?.fixedClaims ?? {};
    const all = type.claims.map((c) => ({
      path: c.path.join("."),
      label:
        c.display.find((d) => d.lang === "en")?.value ??
        c.display[0]?.value ??
        c.path.join("."),
      valueType: c.valueType,
      mandatory: c.mandatory,
    }));
    return {
      fields: all.filter((f) => !(f.path in fixedClaims)),
      fixed: all
        .filter((f) => f.path in fixedClaims)
        .map((f) => ({ label: f.label, value: String(fixedClaims[f.path]) })),
    };
  }

  async issuancePolicySource(policyId: string): Promise<string | undefined> {
    const { tenantId } = await this.call<{ tenantId: string }>("GET", "/v1/me");
    const detail = await this.call<{
      versions?: readonly {
        readonly version: number;
        readonly status: string;
        readonly authenticSource?: { readonly connector?: string };
      }[];
    }>(
      "GET",
      `/v1/tenants/${encodeURIComponent(tenantId)}/issuance-policies/${encodeURIComponent(policyId)}`,
    );
    const published = (detail.versions ?? [])
      .filter((v) => v.status === "PUBLISHED")
      .sort((a, b) => b.version - a.version)[0];
    return published?.authenticSource?.connector;
  }

  /**
   * Active, published issuance policies that issue **from a verified presentation**.
   *
   * These are what a verified presentation can be turned into. One detail request per policy, which
   * is fine at the size of a tenant's policy list and keeps the console to routes the API already has.
   */
  async policiesIssuingFromPresentations(): Promise<readonly IssuanceOption[]> {
    const policies = await this.listIssuancePolicies();
    const candidates = policies.filter(
      (p) => p.status !== "RETIRED" && p.publishedVersion !== null,
    );
    const sources = await Promise.all(
      candidates.map((p) => this.issuancePolicySource(p.id).catch(() => undefined)),
    );
    return candidates.filter((_, i) => sources[i] === "verified-presentation");
  }

  /** What eligibility rules and authentic sources this deployment actually has registered. */
  async issuanceCapabilities(): Promise<{
    readonly eligibilityEvaluators: readonly string[];
    readonly authenticSources: readonly AuthenticSourceOption[];
  }> {
    const { tenantId } = await this.call<{ tenantId: string }>("GET", "/v1/me");
    return this.call(
      "GET",
      `/v1/tenants/${encodeURIComponent(tenantId)}/issuance-capabilities`,
    );
  }

  /** The audit trail of one presentation. */
  async listAudit(presentationId: string): Promise<readonly AuditEvent[]> {
    const body = await this.call<unknown>(
      "GET",
      `/v1/presentations/${encodeURIComponent(presentationId)}/audit`,
    );
    // `{ presentationId, events }`, read from the route rather than assumed — the first version of
    // this looked for `items` and rendered "No recorded events" over a trail that was there. Three
    // defects in this codebase have now come from a shape that was guessed instead of checked
    // (`interop-findings.md` A18, A24, and the console's own error envelope), so the other plausible
    // shapes are tolerated rather than left to fail the same way.
    if (Array.isArray(body)) return body as AuditEvent[];
    const bag = body as { events?: unknown; items?: unknown };
    if (Array.isArray(bag.events)) return bag.events as AuditEvent[];
    return Array.isArray(bag.items) ? (bag.items as AuditEvent[]) : [];
  }

  /** Whether a Service's Relying Party Instance has been provisioned, and in which environment. */
  async readInstance(
    serviceId: string,
  ): Promise<{ provisioned: boolean; trustEnvironment?: string }> {
    const { tenantId } = await this.call<{ tenantId: string }>("GET", "/v1/me");
    try {
      const service = await this.call<{ instance?: { trustEnvironment?: string } }>(
        "GET",
        `/v1/tenants/${encodeURIComponent(tenantId)}/rp-services/${encodeURIComponent(serviceId)}`,
      );
      const env = service.instance?.trustEnvironment;
      return {
        provisioned: service.instance !== undefined,
        ...(env ? { trustEnvironment: env } : {}),
      };
    } catch {
      // A Service with no instance is a normal state, not an error to surface on a list screen.
      return { provisioned: false };
    }
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
 * The platform's error envelope, which is **flat**.
 *
 * `{ error: "attestation_provider_not_provisioned", message: "…", correlationId: "…" }` — `error` is
 * the code as a string, not a nested object. This used to look for `{error: {code, message}}`, found
 * a string where it expected an object, and returned nothing — so **every** platform error the
 * console has ever shown fell back to "The platform API answered 409 Conflict" and the code
 * `platform_api_error`, discarding the actionable half.
 *
 * Found on 13 September 2026 when a 409 that says "the Attestation Provider has no engine tenant
 * yet" — which tells an operator exactly what to do — rendered as the status line. The same shape of
 * defect as `interop-findings.md` A18 and A24: code written against an assumed shape, silent because
 * the fallback looked like a reasonable message.
 *
 * Parsed defensively, and a nested envelope is still tolerated: a console that throws while
 * rendering an error page is worse than one that shows a generic message.
 */
const parseEnvelope = (text: string): { code?: string; message?: string } | undefined => {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const body = parsed as Record<string, unknown>;

    // Nested, if a future version ever sends one.
    if (typeof body.error === "object" && body.error !== null) {
      const nested = body.error as Record<string, unknown>;
      return {
        ...(typeof nested.code === "string" ? { code: nested.code } : {}),
        ...(typeof nested.message === "string" ? { message: nested.message } : {}),
      };
    }

    return {
      ...(typeof body.error === "string" ? { code: body.error } : {}),
      ...(typeof body.message === "string" ? { message: body.message } : {}),
    };
  } catch {
    /* fall through to the generic message */
  }
  return undefined;
};

export const errorCodeOf = (text: string): string =>
  parseEnvelope(text)?.code ?? "platform_api_error";

export const errorMessageOf = (text: string, response: Response): string =>
  // The API's own message, when it gave one. Never the raw body: it could carry anything, and this
  // string is rendered.
  parseEnvelope(text)?.message ??
  `The platform API answered ${response.status} ${response.statusText}.`;
