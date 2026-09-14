import type { DisclosedClaims, RequestedClaim, VerificationPlan } from "@edtp/domain";
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
import { normaliseOutcome } from "./outcome-mapping.js";
import { buildPresentationConfigBody } from "./presentation-config.js";
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
    requestedClaims: readonly RequestedClaim[],
  ): Promise<PresentationResultPayload> {
    const engineSession = await this.readSession(session);
    const status = toStatus(engineSession);

    if (status.progress !== "SETTLED" || status.outcome !== "VERIFIED") {
      return status;
    }

    const disclosed = extractDisclosedClaims(engineSession);
    if (!disclosed) return status;
    return { ...status, disclosedClaims: restoreRequestedShape(disclosed, requestedClaims) };
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
    // The body itself is built by the shared function, because the **issuer** writes one too — for
    // a §7.3 eligibility gate, on its own engine tenant, with its own access certificate. See
    // `presentation-config.ts` and `interop-findings.md` A22.
    const body = buildPresentationConfigBody({
      configId,
      policyId: plan.policyId,
      policyVersion: plan.policyVersion,
      credentialRequirement: plan.credentialRequirement,
      requestedClaims: plan.requestedClaims,
      statusCheckMode: plan.trustConstraints.statusCheckMode,
      accessKeyChainId: plan.relyingPartyContext.accessKeyBindingRef,
      ...(plan.relyingPartyContext.registrationCertificateJwt
        ? { registrationCertificateJwt: plan.relyingPartyContext.registrationCertificateJwt }
        : {}),
    });

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
 * The SD-JWT envelope, which the engine returns alongside the disclosed claims.
 *
 * Dropped here rather than at the result boundary, because they are not disclosed
 * attributes: they are the container the attributes arrived in. `AS-RP-01-002` (`OIA_16`)
 * obliges a Relying Party Instance to discard timestamps as soon as they are no longer
 * needed and never to communicate them, and the earliest point at which that can happen is
 * the moment content crosses out of the engine — `CLAUDE.md` §3.4, minimisation at the
 * source rather than only at the output.
 *
 * `vct` goes too: the policy already knows which credential type it asked for, so echoing
 * it back adds nothing a result could need.
 */
const SD_JWT_ENVELOPE = new Set([
  "iss",
  "iat",
  "exp",
  "nbf",
  "vct",
  "cnf",
  "status",
  "_sd",
  "_sd_alg",
]);

/**
 * Puts disclosed values back where the claim paths address them.
 *
 * The engine does not return them that way for every format. An **mdoc** claim path is
 * `[namespace, element]` — `["org.iso.18013.5.1", "family_name"]` — and the engine returns
 * `{ family_name: … }`, with the namespace gone. The result policy then reads
 * `disclosed["org.iso.18013.5.1"]`, finds nothing, and reports the policy unsatisfied for a
 * presentation the engine verified successfully.
 *
 * Found on the first mdoc presentation ever made against this platform, 13 September 2026: engine
 * `outcome.result: "success"`, `verified: true`, `family_name` disclosed — and the platform answered
 * `POLICY_NOT_SATISFIED`. `interop-findings.md` A24, and the same shape as A18: a translation the
 * adapter owed and did not make, invisible to every test that could not produce a real presentation.
 *
 * **Driven by what was asked, not by what arrived.** For each requested path whose final segment
 * matches a flat key the engine returned, the value is nested back under the path's own prefix. A
 * key that already sits where a path addresses it is left alone, so SD-JWT VC — where the engine's
 * shape already matches — passes through untouched.
 *
 * It deliberately does **not** guess a namespace from the doctype. `org.iso.18013.5.1.mDL` happens
 * to contain its namespace; nothing guarantees that of any other document type, and a rule that
 * works for one doctype and silently mis-nests another is worse than no rule.
 */
export const restoreRequestedShape = (
  disclosed: DisclosedClaims,
  requestedClaims: readonly RequestedClaim[],
): DisclosedClaims => {
  const nested = requestedClaims.filter((c) => c.path.length > 1);
  if (nested.length === 0) return disclosed;

  const out: Record<string, unknown> = {};
  const consumed = new Set<string>();

  for (const claim of nested) {
    const leaf = claim.path[claim.path.length - 1];
    if (typeof leaf !== "string") continue;
    // Only when the engine flattened it. If the value is already at the full path the engine
    // returned the shape the policy expects, and moving it would be the bug rather than the fix.
    if (readAtPath(disclosed, claim.path) !== undefined) continue;
    if (!(leaf in disclosed)) continue;

    let cursor = out;
    for (const segment of claim.path.slice(0, -1)) {
      if (typeof segment !== "string") break;
      cursor[segment] ??= {};
      const next = cursor[segment];
      if (typeof next !== "object" || next === null) break;
      cursor = next as Record<string, unknown>;
    }
    cursor[leaf] = (disclosed as Record<string, unknown>)[leaf];
    consumed.add(leaf);
  }

  // Anything the engine returned that no requested path re-homed stays exactly where it was.
  for (const [key, value] of Object.entries(disclosed)) {
    if (!consumed.has(key)) out[key] = value;
  }
  return out as DisclosedClaims;
};

/** Reads a value at a path, for the "already in the right place" check above. */
const readAtPath = (source: unknown, path: readonly (string | number | null)[]): unknown => {
  let current: unknown = source;
  for (const segment of path) {
    if (current === null || current === undefined) return undefined;
    if (typeof segment !== "string") return undefined;
    if (typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};

/**
 * Extracts the disclosed claims of the single requested credential.
 *
 * The engine returns `credentials` as an array of `{ id, values }`, where `id` is the DCQL
 * credential id and `values` holds one claim object per presented instance. A V0 policy
 * requests one credential and expects one instance, so anything else means the engine
 * configuration and the plan have diverged. Failing loudly is safer than merging, which
 * would silently accept a credential the policy never asked for.
 */
export const extractDisclosedClaims = (
  session: EngineSessionResponse,
): DisclosedClaims | undefined => {
  const credentials = session.credentials;
  if (!credentials || credentials.length === 0) return undefined;
  if (credentials.length > 1) {
    throw PlatformError.engine(
      "engine_returned_unexpected_credentials",
      "The engine returned more disclosed credentials than the policy requested.",
    );
  }

  const values = credentials[0]?.values;
  if (!values || values.length === 0) return undefined;
  if (values.length > 1) {
    throw PlatformError.engine(
      "engine_returned_unexpected_credentials",
      "The engine returned more than one instance of the requested credential.",
    );
  }

  const claims = values[0];
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) return undefined;
  const disclosed = Object.fromEntries(
    Object.entries(claims).filter(([key]) => !SD_JWT_ENVELOPE.has(key)),
  );
  return Object.keys(disclosed).length > 0 ? (disclosed as DisclosedClaims) : undefined;
};
