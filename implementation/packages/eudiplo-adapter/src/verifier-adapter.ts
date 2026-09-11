import type { DisclosedClaims, VerificationPlan } from "@edtp/domain";
import type {
  CreatePresentationRequestInput,
  CreatePresentationRequestOutput,
  EngineRetentionSettings,
  EngineSessionHandle,
  EudiVerifierPort,
  EudiVerifierProvisioningPort,
  ImportAccessCertificateInput,
  PresentationResultPayload,
  PresentationStatus,
} from "@edtp/eudi-verifier-port";
import { asId, PlatformError } from "@edtp/shared";
import type { EngineClient } from "./client.js";
import { buildDcqlQuery, toEngineStatusCheckMode } from "./dcql.js";
import { normaliseOutcome } from "./outcome-mapping.js";
import {
  type EngineSessionResponse,
  engineOfferResponseSchema,
  engineSessionSchema,
  keyChainIdSchema,
} from "./schemas.js";

/**
 * The verifier adapter: the anti-corruption layer around the protocol engine.
 *
 * Every route and payload was verified against EUDIPLO v7.6.0 source at commit
 * `3b2a9e7`, not against its prose documentation, which diverges in at least seven
 * places (`docs/interop-findings.md` section A). Routes used:
 *
 * ```
 * POST   /api/verifier/config     create or replace a presentation configuration
 * POST   /api/verifier/offer      create a presentation request
 * GET    /api/session/:id         read status and, once settled, the result
 * DELETE /api/session/:id         cancel, and purge the engine-side session
 * PUT    /api/session-config      apply retention settings (provisioning)
 * POST   /api/key-chain/import    import an access certificate (provisioning)
 * GET    /health                  protocol API, deliberately unprefixed
 * ```
 *
 * The `/api` prefix is added by `EngineClient.request`, so the paths written below omit it.
 * Management routes live under `/api`; `/health` belongs to the wallet-facing protocol
 * document and does not. Getting this wrong produces a `404` on every management call and
 * nothing else — `docs/interop-findings.md` A10.
 *
 * The adapter is **stateless**. Every method that addresses an existing session takes
 * an `EngineSessionHandle` carrying both the session and its engine tenant, because the
 * engine scopes each call to the tenant of the presenting token. The platform stores
 * both on the transaction, so nothing is held in process memory and a restart loses
 * nothing.
 */
export class EudiploVerifierAdapter implements EudiVerifierPort, EudiVerifierProvisioningPort {
  constructor(private readonly client: EngineClient) {}

  async createPresentationRequest(
    input: CreatePresentationRequestInput,
  ): Promise<CreatePresentationRequestOutput> {
    const { plan, interactionType, returnUrl, sessionTtlSeconds } = input;
    const engineTenantRef = plan.relyingPartyContext.engineTenantRef;

    // Size the engine session window before creating the session, so no session can
    // ever be created under the engine's 24-hour default. ADR 0004 makes this
    // mandatory rather than advisory.
    await this.applyRetentionSettings(engineTenantRef, {
      sessionTtlSeconds,
      cleanupMode: "ANONYMIZE",
    });

    const configId = presentationConfigId(plan);
    await this.upsertPresentationConfig(engineTenantRef, configId, plan);

    // The engine returns both `uri` and `crossDeviceUri`. `uri` carries the
    // post-completion redirect and is the same-device variant; `crossDeviceUri` omits
    // it. ADR 0005 Decision 6 makes SAME_DEVICE the tested V0 path.
    const offer = engineOfferResponseSchema.parse(
      await this.client.request(engineTenantRef, "POST", "/verifier/offer", {
        response_type: "uri",
        requestId: configId,
        ...(returnUrl ? { redirectUri: returnUrl } : {}),
      }),
    );

    const uri = interactionType === "QR" ? (offer.crossDeviceUri ?? offer.uri) : offer.uri;

    return {
      session: {
        ref: asId<"EngineSessionRef">(offer.session),
        engineTenantRef,
      },
      interaction: { type: interactionType, uri },
      sentWithoutRegistrationCertificate:
        plan.relyingPartyContext.registrationCertificateJwt === undefined,
    };
  }

  async getPresentationStatus(session: EngineSessionHandle): Promise<PresentationStatus> {
    return toStatus(await this.readSession(session));
  }

  async processPresentationResult(
    session: EngineSessionHandle,
  ): Promise<PresentationResultPayload> {
    const engineSession = await this.readSession(session);
    const status = toStatus(engineSession);

    if (status.progress !== "SETTLED" || status.outcome !== "VERIFIED") {
      return status;
    }

    const disclosed = extractDisclosedClaims(engineSession);
    return { ...status, ...(disclosed ? { disclosedClaims: disclosed } : {}) };
  }

  async cancelPresentation(session: EngineSessionHandle): Promise<void> {
    // Deleting the engine session both cancels the flow and removes the engine-side
    // record, which is the earliest point at which any content it holds disappears.
    await this.client.request(
      session.engineTenantRef,
      "DELETE",
      `/session/${encodeURIComponent(session.ref)}`,
    );
  }

  // --- provisioning ---------------------------------------------------------

  async applyRetentionSettings(
    engineTenantRef: string,
    settings: EngineRetentionSettings,
  ): Promise<void> {
    // The engine enforces a minimum of 60 seconds and rejects anything lower.
    const ttlSeconds = Math.max(60, Math.floor(settings.sessionTtlSeconds));
    await this.client.request(engineTenantRef, "PUT", "/session-config", {
      ttlSeconds,
      cleanupMode: settings.cleanupMode === "ANONYMIZE" ? "anonymize" : "full",
    });
  }

  /**
   * Imports an access certificate into the engine key store.
   *
   * `POST /key-chain/import` takes an **EC private key in JWK form** plus an optional
   * certificate chain (leaf first, PEM or base64 DER) — not a PKCS#12 blob. A P12 from
   * a registrar must be converted first; `scripts/import-access-certificate.sh` does
   * that with `openssl`.
   *
   * The private key passes through this process in memory only. The platform stores the
   * opaque key-binding reference the engine returns and never the key.
   */
  async importAccessCertificate(
    input: ImportAccessCertificateInput,
  ): Promise<{ readonly keyBindingRef: string }> {
    const response = keyChainIdSchema.parse(
      await this.client.request(input.engineTenantRef, "POST", "/key-chain/import", {
        key: input.privateKeyJwk,
        usageType: "access",
        description: input.name,
        crt: [...input.certificateChain],
      }),
    );
    return { keyBindingRef: response.id };
  }

  async healthy(): Promise<boolean> {
    return this.client.health();
  }

  // --- internals ------------------------------------------------------------

  private async upsertPresentationConfig(
    engineTenantRef: string,
    configId: string,
    plan: VerificationPlan,
  ): Promise<void> {
    const body: Record<string, unknown> = {
      id: configId,
      // The engine's own documentation notes this description is not shown to the end
      // user. The user-facing text is the registration certificate's `purpose`.
      description: `Platform policy ${plan.policyId} version ${plan.policyVersion}`,
      dcql_query: buildDcqlQuery(plan),
      statusCheckMode: toEngineStatusCheckMode(plan.trustConstraints.statusCheckMode),
      accessKeyChainId: plan.relyingPartyContext.accessKeyBindingRef,
    };

    const jwt = plan.relyingPartyContext.registrationCertificateJwt;
    if (jwt) {
      // `registrationCertImportJwt` attaches a certificate we already hold, with no registrar
      // call to issue one. The engine validates it and checks that it authorises every
      // credential in the DCQL query — the engine-side half of the over-asking prevention in
      // ADR 0005 Decision 2; it refuses a certificate with no authorised-credentials claim.
      //
      // **The field name and its type were both wrong here.** This sent
      // `registrationCert: { jwt }`, which `PresentationConfigCreateDto` rejects outright —
      // it declares `additionalProperties: false`, so the engine answers
      // `unrecognized key(s) "registrationCert"` with a 400. The defect was invisible because
      // V0 holds no certificate, so the branch never executed. Verified empirically against
      // v7.6.0 on 11 September 2026; see `docs/interop-findings.md` A12.
      //
      // A second trap: the engine's own OpenAPI document declares this field as
      // `{type: "array", items: {type: "string"}}`, but its zod validator wants a **string**
      // and rejects an array with `expected string, received array`. The validator is the
      // authority, as CLAUDE.md §6 item 10 says of this engine generally.
      body.registrationCertImportJwt = jwt;
    }
    // With no registration certificate the request goes without one. V0 has no reachable
    // provider (blocker B3); the omission is reported upward, never faked.

    await this.client.request(engineTenantRef, "POST", "/verifier/config", body);
  }

  private async readSession(session: EngineSessionHandle): Promise<EngineSessionResponse> {
    return engineSessionSchema.parse(
      await this.client.request(
        session.engineTenantRef,
        "GET",
        `/session/${encodeURIComponent(session.ref)}`,
      ),
    );
  }
}

/**
 * The engine configuration id for a published policy version.
 *
 * Keyed by policy id and version so a published version — which is immutable — always
 * resolves to the same engine configuration, and publishing a new version never mutates
 * the configuration an in-flight transaction is using.
 */
export const presentationConfigId = (plan: VerificationPlan): string =>
  `p-${plan.policyId}-v${plan.policyVersion}`;

export const toStatus = (session: EngineSessionResponse): PresentationStatus => {
  const normalised = normaliseOutcome({
    status: session.status,
    failureCode: session.failureCode ?? null,
    outcomeError: session.outcome?.error ?? null,
    outcomeResult: session.outcome?.result ?? null,
    message: session.outcome?.message ?? session.errorReason ?? null,
  });
  return {
    progress: normalised.progress,
    ...(normalised.outcome ? { outcome: normalised.outcome } : {}),
    ...(normalised.failureCode ? { failureCode: normalised.failureCode } : {}),
    ...(normalised.failureMessage ? { failureMessage: normalised.failureMessage } : {}),
    ...(normalised.verifierSideFailure ? { verifierSideFailure: true } : {}),
  };
};

/**
 * Extracts the disclosed claims of the single requested credential.
 *
 * `verifiedClaims` is keyed by the DCQL credential id. A V0 policy requests one
 * credential, so more than one disclosed credential means the engine configuration and
 * the plan have diverged. Failing loudly is safer than merging, which would silently
 * accept a credential the policy never asked for.
 */
export const extractDisclosedClaims = (
  session: EngineSessionResponse,
): DisclosedClaims | undefined => {
  const verified = session.verifiedClaims;
  if (!verified) return undefined;
  const entries = Object.entries(verified);
  if (entries.length === 0) return undefined;
  if (entries.length > 1) {
    throw PlatformError.engine(
      "engine_returned_unexpected_credentials",
      "The engine returned more disclosed credentials than the policy requested.",
    );
  }
  const value = entries[0]?.[1];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as DisclosedClaims)
    : undefined;
};
