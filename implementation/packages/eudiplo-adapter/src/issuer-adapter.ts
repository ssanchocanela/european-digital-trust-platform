import type { CredentialStatus, IssuancePlan, SourceAttributes } from "@edtp/domain";
import type {
  CreateCredentialOfferInput,
  CreateCredentialOfferOutput,
  CredentialOfferHandle,
  EudiIssuerPort,
  EudiIssuerProvisioningPort,
  IssuanceProvisioningInput,
  IssuanceStatus,
  ProviderAuthenticationEvidence,
} from "@edtp/eudi-issuer-port";
import { asId, PlatformError } from "@edtp/shared";
import type { EngineClient } from "./client.js";
import { normaliseIssuanceOutcome } from "./issuance-outcome-mapping.js";
import { buildPresentationConfigBody } from "./presentation-config.js";
import {
  engineCredentialIssuerMetadataSchema,
  engineIssuerOfferResponseSchema,
  engineSessionSchema,
  keyChainIdSchema,
} from "./schemas.js";

/**
 * The issuer adapter: the anti-corruption layer around the protocol engine's issuance side.
 *
 * Every route and payload below was verified against the **running** EUDIPLO v7.6.0 container and
 * its Management API document, not against its prose documentation. Milestone 1 found five defects
 * that way, three of them in routes Phase 0 had recorded from documentation, so this was built
 * against the live contract from the start.
 *
 * ```
 * POST   /api/issuer/config          issuance configuration (authorization servers, issuer_info)
 * POST   /api/issuer/credentials     credential configuration (vct, claim fields, status, trust)
 * POST   /api/issuer/offer           create a credential offer
 * GET    /api/session/:id            read issuance status
 * POST   /api/session/revoke         status mutation — session-keyed, see below
 * DELETE /api/session/:id            cancel and purge the engine-side session
 * POST   /api/key-chain/import       import the attestation-signing key and chain
 * GET    /.well-known/openid-credential-issuer/issuers/:tenant   Wallet-facing metadata
 * ```
 *
 * The `/api` prefix is added by `EngineClient.request`; the well-known document belongs to the
 * engine's **protocol** API and is unprefixed, which is why it is fetched differently.
 *
 * The adapter is **stateless**: every call addressing an existing session takes a handle carrying
 * both the session and its engine tenant, because the engine scopes each call to the tenant of the
 * presenting token.
 */
export class EudiploIssuerAdapter implements EudiIssuerPort, EudiIssuerProvisioningPort {
  constructor(private readonly client: EngineClient) {}

  async createCredentialOffer(
    input: CreateCredentialOfferInput,
  ): Promise<CreateCredentialOfferOutput> {
    const { plan, claims, sessionTtlSeconds } = input;
    const engineTenantRef = plan.providerContext.engineTenantRef;

    // Size the engine session window before any session exists, so none can be created under the
    // engine's 24-hour default. ADR 0004 makes this mandatory on the issuance side too: the engine
    // persists inline issuance claims on its session rows, so this bounds how long the attribute
    // values live inside the engine.
    await this.applyRetention(engineTenantRef, sessionTtlSeconds);

    const configId = credentialConfigId(plan);

    const offer = engineIssuerOfferResponseSchema.parse(
      await this.client.request(engineTenantRef, "POST", "/issuer/offer", {
        response_type: "uri",
        flow:
          plan.flow === "PRE_AUTHORIZED_CODE" ? "pre_authorized_code" : "authorization_code",
        credentialConfigurationIds: [configId],
        // The attribute values, as a **tagged union**: the engine accepts `inline`,
        // `attributeProvider` or `webhook` per configuration, and a bare claims object is
        // rejected with `invalid_union`. `inline` is the platform's mode — the platform owns the
        // authentic-source connector and hands the values over, rather than letting the engine
        // fetch them, which keeps the connector contract and the privacy boundary on our side.
        credentialClaims: {
          [configId]: { type: "inline", claims: claims as Record<string, unknown> },
        },
        // **Named, not left to the engine.** The tenant advertises every authorization server its
        // provider needs (A20), and the offer has to say which one *this* credential goes through.
        // Without it the engine picks for itself and chose the built-in one, so a policy gated on a
        // presentation minted an offer that skipped the gate entirely — the metadata advertised the
        // `oid4vp` server and the offer never pointed at it.
        //
        // Verified on the running engine, 13 September 2026: an offer without this field carries
        // `"authorization_server": ".../issuers/{ref}"` whatever the policy says.
        ...(plan.eligibilityPresentationPolicyId
          ? {
              authorization_server: eligibilityAuthorizationServerId(
                plan.eligibilityPresentationPolicyId,
              ),
            }
          : {}),
      }),
    );

    return {
      session: {
        ref: asId<"EngineSessionRef">(offer.session),
        engineTenantRef,
      },
      uri: offer.uri,
      sentWithoutRegistrationCertificate:
        plan.providerContext.registrationCertificateJwt === undefined,
    };
  }

  async getIssuanceStatus(session: CredentialOfferHandle): Promise<IssuanceStatus> {
    const engineSession = engineSessionSchema.parse(
      await this.client.request(
        session.engineTenantRef,
        "GET",
        `/session/${encodeURIComponent(session.ref)}`,
      ),
    );
    return normaliseIssuanceOutcome(engineSession);
  }

  async updateCredentialStatus(input: {
    readonly session: CredentialOfferHandle;
    readonly status: CredentialStatus;
    readonly policyId: string;
    readonly policyVersion: number;
  }): Promise<void> {
    // The engine exposes status mutation only as a session-keyed call. The platform has already
    // approved the transition in the domain — in particular that `REVOKED` is terminal
    // (`AS-AP-07-007` / `VCR_04`), which the engine itself does **not** enforce.
    //
    // `credentialConfigurationId` is sent even though the engine's own contract marks it optional,
    // because **the optional path is the one that crashes**: omitting it makes the engine build a
    // `where` condition on an undefined column value and answer `500`
    // (`StatusListService.updateStatus`). Measured on one session with one status and two calls —
    // without the field `500`, with it `204`. So this is not belt-and-braces; it is the difference
    // between revocation working and not working at all. `interop-findings.md` A26.
    //
    // Sending it also narrows the call to this transaction's own configuration, which is what the
    // platform means anyway: a status change applies to the attestation issued here, not to every
    // credential the engine happens to have linked to the session.
    await this.client.request(input.session.engineTenantRef, "POST", "/session/revoke", {
      sessionId: input.session.ref,
      credentialConfigurationId: credentialConfigIdFor(input.policyId, input.policyVersion),
      status: toEngineStatus(input.status),
    });
  }

  async cancelIssuance(session: CredentialOfferHandle): Promise<void> {
    // Deleting the engine session cancels the flow and removes the engine-side record, which is
    // the earliest point any attribute values it holds disappear.
    await this.client.request(
      session.engineTenantRef,
      "DELETE",
      `/session/${encodeURIComponent(session.ref)}`,
    );
  }

  // --- provisioning ---------------------------------------------------------

  async provisionCredentialConfiguration(input: IssuanceProvisioningInput): Promise<void> {
    const { plan, engineTenantRef } = input;

    // 1. The issuance configuration. This call is **tenant-scoped**, and that is the whole
    //    difficulty: `authorizationServers`, `display` and `registrationCertificate` describe the
    //    Credential Issuer, not the credential configuration written in step 2. Composing them from
    //    the credential type being provisioned meant every issuance silently overwrote the previous
    //    one's — `interop-findings.md` A20 — so they are composed from the **provider** instead.
    //
    // The authorization server list is a **discriminated union** on `type`; an entry without it is
    // accepted by the DTO but then ignored, and the offer fails later with "No enabled
    // authorization server configured" — a failure a long way from its cause, which is why this is
    // pinned by a contract test.
    //
    // Two shapes matter here, and the choice implements the §7.3 stretch goal:
    //
    //   `built-in`  the engine's own token endpoint. The default path.
    //   `oid4vp`    the engine runs an OpenID4VP presentation *as the authorization step*, using a
    //               presentation configuration by id — so eligibility can require a PID before
    //               issuing, **reusing a verification policy** exactly as §7.3 asks. The engine
    //               supports this natively; the platform only has to name the configuration.
    //
    // Both are sent when the provider needs both. Verified against the engine on 13 September 2026:
    // the metadata then advertises both `…/issuers/{ref}` and
    // `…/issuers/{ref}/authorization-servers/eligibility-oid4vp`, which is what makes an offer
    // naming either of them consistent with what the Wallet reads. A20 proposed a second engine
    // tenant per authorization model; it is not needed, because the engine takes a list.
    const context = plan.providerContext;
    const authorizationServers: Record<string, unknown>[] = [];
    if (context.requiresBuiltInAuthorizationServer) {
      // `id` must not be "built-in": the engine reserves that value and answers
      // `Authorization server id 'built-in' is reserved`. A platform-owned name avoids the clash
      // and makes the engine-side object traceable to us.
      authorizationServers.push({ type: "built-in", id: "edtp-issuer-as", enabled: true });
    }
    if (context.eligibilityPresentations.length > 0 && !context.accessKeyBindingRef) {
      // The eligibility presentation is a **signed request object from the issuer**, and a Wallet
      // Unit accepts only an access certificate chaining to an anchor from a notified list
      // (`AS-WP-06-005` / `RPA_04`). Without one, provisioning would produce an authorization step
      // that fails on the phone with a message about the relying party — a failure a long way from
      // its cause, which is the whole lesson of `interop-findings.md` A22.
      throw PlatformError.engine(
        "attestation_provider_has_no_access_certificate",
        "This Attestation Provider gates issuance on a presentation but was provisioned without " +
          "an access certificate. The request object would be signed by the wrong party, or not " +
          "at all, and no Wallet would accept it.",
      );
    }

    for (const eligibility of context.eligibilityPresentations) {
      // **Written here, on the issuer's own engine tenant.** It used to be referenced and never
      // written: the verifier adapter creates presentation configurations lazily, on the *Relying
      // Party Instance's* tenant, at the first presentation. A gating policy nobody had presented
      // against therefore resolved to nothing, and the engine accepts that silently (A21). It
      // worked only where one engine tenant served both roles. `interop-findings.md` A22.
      //
      // Signed with the provider's access certificate, not the Relying Party's: reusing a
      // verification policy means reusing its *content*, not the other party's credentials.
      const configId = presentationConfigIdFor(eligibility.policyId, eligibility.policyVersion);
      await this.client.request(
        engineTenantRef,
        "POST",
        "/verifier/config",
        buildPresentationConfigBody({
          configId,
          policyId: eligibility.policyId,
          policyVersion: eligibility.policyVersion,
          credentialRequirement: eligibility.credentialRequirement,
          requestedClaims: eligibility.requestedClaims,
          statusCheckMode: eligibility.statusCheckMode,
          // The provider's own, guaranteed present by the check above.
          accessKeyChainId: context.accessKeyBindingRef as string,
        }),
      );

      authorizationServers.push({
        type: "oid4vp",
        // One per gating policy, so two PID-gated credential types on one provider do not collide
        // on a shared id — which would be A20 again, one level down.
        id: eligibilityAuthorizationServerId(eligibility.policyId),
        presentationConfigId: configId,
        enabled: true,
      });
    }
    if (authorizationServers.length === 0) {
      // The engine requires at least one. Reaching here would mean the provider view was composed
      // without the policy currently being provisioned, which is a platform bug rather than a
      // configuration error — so it fails loudly instead of emitting a tenant nothing can use.
      throw PlatformError.engine(
        "issuer_authorization_servers_empty",
        "No authorization server could be composed for the Attestation Provider.",
      );
    }

    const issuanceConfig: Record<string, unknown> = {
      authorizationServers,
      // The **issuer's** name, not the credential's. See `PlanAttestationProviderContext`.
      display: [{ name: context.issuerDisplayName, locale: "en" }],
      batchSize: 1,
      notificationEndpointEnabled: true,
    };

    const registrationCertificateJwt = plan.providerContext.registrationCertificateJwt;
    if (registrationCertificateJwt) {
      // `enabled` is load-bearing: `appendIssuerRegistrationCertificateInfo` returns early
      // without it, so the certificate would be stored and never published.
      // `mode: "import"` with `jwt` — the engine's other mode, `generate`, would have it call a
      // registrar to mint one, which V0 has no registrar for. `enabled` is separately load-bearing:
      // `appendIssuerRegistrationCertificateInfo` returns early without it, so the certificate
      // would be stored and silently never published.
      issuanceConfig.registrationCertificate = {
        enabled: true,
        mode: "import",
        jwt: registrationCertificateJwt,
      };
    }
    // With no certificate the metadata simply carries no `issuer_info`. The omission is reported
    // upward by `createCredentialOffer`, never faked.

    await this.client.request(engineTenantRef, "POST", "/issuer/config", issuanceConfig);

    // 2. The credential configuration.
    const configId = credentialConfigId(plan);
    const body: Record<string, unknown> = {
      id: configId,
      description: `Platform credential type for policy ${plan.policyId} v${plan.policyVersion}`,
      config: buildIssuerMetadataCredentialConfig(plan),
      fields: plan.credential.claims.map((claim) => ({
        // The engine's claim field definition is flat-path based.
        path: [...claim.path],
        display: claim.display.map((d) => ({ name: d.value, locale: d.lang })),
        mandatory: claim.mandatory,
      })),
      keyBinding: plan.holderBinding === "KEY_BOUND",
      statusManagement: plan.statusListEnabled,
      keyChainId: plan.providerContext.signingKeyBindingRef,
      lifeTime: plan.credentialValiditySeconds,
      // Trust gate (b). `x5c` embeds the certificate chain in the attestation, so a verifier can
      // build a path to an anchor named by the Rulebook or a published list — which is what
      // ARF §6.3.2.4 describes. `federation` would instead resolve trust through OpenID
      // Federation, a mechanism the ARF does not use for non-qualified EAA signature trust.
      sdJwtTrustFormat: "x5c",
    };

    if (plan.credential.vct) body.vct = plan.credential.vct;

    await this.client.request(engineTenantRef, "POST", "/issuer/credentials", body);
  }

  async importSigningCertificate(input: {
    readonly engineTenantRef: string;
    readonly name: string;
    readonly privateKeyJwk: Readonly<Record<string, unknown>>;
    readonly certificateChain: readonly string[];
  }): Promise<{ readonly keyBindingRef: string }> {
    const response = keyChainIdSchema.parse(
      await this.client.request(input.engineTenantRef, "POST", "/key-chain/import", {
        key: input.privateKeyJwk,
        // `attestation`, not `access`: this key signs attestations, not presentation requests, and
        // the access usage type would put the wrong key in the wrong role.
        //
        // The engine's enum is `access | attestation | trustList | statusList | encrypt`. "signing"
        // is *not* among them — it was the obvious guess and the engine answered
        // `Validation failed`, which is why the value is pinned by a contract test rather than by
        // reading the field name. (`trustList` is the usage for signing a published ETSI TS 119 602
        // list, which is what `TrustAnchorPublication` will need.)
        usageType: "attestation",
        description: input.name,
        crt: [...input.certificateChain],
      }),
    );
    return { keyBindingRef: response.id };
  }

  /**
   * The provider's own access certificate, for the §7.3 eligibility presentation.
   *
   * `usageType: "access"` — the same value the verifier adapter uses, and for the same reason: this
   * key signs a presentation *request*. What makes it a separate method rather than a flag is that
   * the two keys belong to different roles the same organisation plays, and one method taking a
   * usage type would make it possible to pass the wrong one. `interop-findings.md` A22.
   */
  async importAccessCertificate(input: {
    readonly engineTenantRef: string;
    readonly name: string;
    readonly privateKeyJwk: Readonly<Record<string, unknown>>;
    readonly certificateChain: readonly string[];
  }): Promise<{ readonly keyBindingRef: string }> {
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

  /**
   * Fetches the provider-authentication evidence a Wallet would see — trust gate (a).
   *
   * Deliberately reads the **well-known** document rather than the management API, because the
   * question is what a Wallet receives, not what the platform configured. Those differ: Milestone 1
   * found the engine storing a registration certificate it then declined to publish.
   */
  async fetchProviderAuthenticationEvidence(
    engineTenantRef: string,
  ): Promise<ProviderAuthenticationEvidence> {
    const raw = await this.client.fetchProtocol(
      `/.well-known/openid-credential-issuer/issuers/${encodeURIComponent(engineTenantRef)}`,
    );
    const metadata = engineCredentialIssuerMetadataSchema.parse(raw);

    const issuerInfo = metadata.issuer_info ?? [];
    const registrationCert = issuerInfo.find((i) => i.format === "registration_cert");

    // `signed_metadata` is the OpenID4VCI (clause 12.2.3) mechanism by which a Wallet authenticates
    // the metadata document itself, and ETSI TS 119 472-3 routes both certificates through it. The
    // engine at the pinned version does not emit it, so everything derived from it is false — but it
    // is derived rather than hard-coded, so a release that adds support is reported accurately.
    const signed =
      typeof metadata.signed_metadata === "string"
        ? inspectSignedMetadata(metadata.signed_metadata)
        : undefined;

    return {
      credentialIssuer: metadata.credential_issuer,
      registrationCertificatePresent: registrationCert !== undefined,
      ...(registrationCert?.data ? { registrationCertificateJwt: registrationCert.data } : {}),
      metadataSigned: signed !== undefined,
      accessCertificateInSignedMetadata: signed?.hasX5c ?? false,
      registrationCertificateInSignedPayload: signed?.hasIssuerInfo ?? false,
      credentialConfigurationIds: Object.keys(
        metadata.credential_configurations_supported ?? {},
      ),
    };
  }

  async healthy(): Promise<boolean> {
    return this.client.health();
  }

  // --- internals ------------------------------------------------------------

  private async applyRetention(
    engineTenantRef: string,
    sessionTtlSeconds: number,
  ): Promise<void> {
    // The engine enforces a 60-second floor and rejects anything lower, so clamp rather than
    // letting the engine refuse the call.
    await this.client.request(engineTenantRef, "PUT", "/session-config", {
      ttlSeconds: Math.max(60, Math.floor(sessionTtlSeconds)),
      cleanupMode: "anonymize",
    });
  }
}

/**
 * Stable engine-side identifier for a credential configuration.
 *
 * Derived from the policy and version so re-provisioning is idempotent and a published version's
 * configuration can never be silently replaced by a different version's.
 *
 * Two callers, one rule: provisioning writes the configuration under this id, and a status change
 * names the same id so the engine narrows the update to it. They must not drift, which is why the
 * format lives in one function rather than in a template string at each site.
 */
const credentialConfigIdFor = (policyId: string, policyVersion: number): string =>
  `c-${policyId}-v${policyVersion}`;

const credentialConfigId = (plan: IssuancePlan): string =>
  credentialConfigIdFor(plan.policyId, plan.policyVersion);

/**
 * The engine-side presentation configuration id for a verification policy.
 *
 * **Deliberately distinct from the verifier adapter's id**, which is `p-<policyId>-v<version>`.
 *
 * The two write the same engine endpoint, and on an engine tenant that serves both a Relying Party
 * Instance and an Attestation Provider they would write the same object — with different
 * `accessKeyChainId`s, because the two are different parties. Observed on the running stack: creating
 * an ordinary presentation with a gating policy rewrote the configuration from the Attestation
 * Provider's access key to the Relying Party's, after which the issuer's eligibility request would
 * have been signed by the wrong party and a Wallet told a different organisation was asking.
 *
 * `interop-findings.md` A23. The same A20 family: one tenant-scoped engine object with two owners.
 *
 * The version is the eligibility presentation's own, not a hard-coded 1: a published version is
 * immutable, so the id resolves to the same configuration for the life of that version and
 * publishing a new one never mutates what an in-flight issuance is using.
 */
const presentationConfigIdFor = (presentationPolicyId: string, version: number): string =>
  `elig-p-${presentationPolicyId}-v${version}`;

/**
 * The engine-side id of the authorization server that gates issuance on one presentation policy.
 *
 * Derived from the policy rather than fixed, because a provider may gate two credential types on
 * two different policies and a shared id would let one overwrite the other inside the same call —
 * the same defect as A20, one level down.
 */
const eligibilityAuthorizationServerId = (presentationPolicyId: string): string =>
  `eligibility-${presentationPolicyId}`;

/**
 * Proof types this issuer advertises, and why it is only `jwt`.
 *
 * The engine defaults to `["attestation", "jwt"]` and emits the `attestation` entry as bare
 * `{proof_signing_alg_values_supported: [...]}`. **That document does not parse.** The wallet's
 * OpenID4VCI library refuses it outright:
 *
 *     IllegalArgumentException: attestation proof must contain 'key_attestations_required'
 *       at CredentialIssuerMetadataJsonParser.proofTypeMeta
 *     -> CredentialIssuerMetadataValidationError.InvalidCredentialsSupported
 *     -> CredentialOfferRequestError.UnableToResolveCredentialIssuerMetadata
 *
 * and one malformed entry fails the **whole** metadata document, so every credential configuration
 * on the tenant becomes unreadable — not just the one being offered. The wallet then shows a
 * generic error carrying no message, because the exception has none. `interop-findings.md` A28.
 *
 * Advertising `attestation` is also a claim the platform cannot back. It means "I accept a key
 * attestation as proof", and the accompanying `key_attestations_required` is what states the key
 * storage and user authentication levels demanded. V0 demands none, so there is nothing truthful to
 * put there — and announcing the proof type while declining to say what it requires is exactly the
 * malformed shape the library rejects. `jwt` is what this issuer actually accepts, and it is the
 * proof the platform's own contract test builds.
 */
const PROOF_TYPES_SUPPORTED = ["jwt"] as const;

/**
 * The key-attestation requirement published beside the proof type.
 *
 * **This is a parser requirement, not a security property, and it must never be described as one.**
 * The platform does not verify a key attestation and the wrapped engine does not either.
 *
 * It is published because the wallet's OpenID4VCI library refuses metadata without it. The
 * specification marks `key_attestations_required` OPTIONAL; `eudi-lib-jvm-openid4vci-kt` 0.13.1
 * treats it as mandatory on every proof type, and rejects both encodings that would mean "required,
 * with no constraints" — an empty object reads as absent, and an empty `key_storage` array is
 * refused outright with "keyStorage, if provided, must be non-empty". So an issuer that demands
 * nothing has no way to say so, and since one malformed entry fails the **whole** metadata document,
 * a single such configuration makes every credential on the tenant unreadable.
 * `interop-findings.md` A28.
 *
 * `iso_18045_basic` is the lowest of the four levels the library accepts. Chosen deliberately: it
 * is the least a wallet has to satisfy, and the least this document can be read as claiming.
 */
const KEY_ATTESTATIONS_REQUIRED = { key_storage: ["iso_18045_basic"] } as const;

const buildIssuerMetadataCredentialConfig = (plan: IssuancePlan): Record<string, unknown> => {
  if (plan.credential.format === "dc+sd-jwt") {
    return {
      format: "dc+sd-jwt",
      vct: plan.credential.vct,
      display: plan.credential.display.map((d) => ({ name: d.value, locale: d.lang })),
      ...(plan.holderBinding === "KEY_BOUND"
        ? { cryptographic_binding_methods_supported: ["jwk"] }
        : {}),
      credential_signing_alg_values_supported: ["ES256"],
      proofTypesSupported: [...PROOF_TYPES_SUPPORTED],
      keyAttestationsRequired: { key_storage: [...KEY_ATTESTATIONS_REQUIRED.key_storage] },
    };
  }
  return {
    format: "mso_mdoc",
    doctype: plan.credential.doctype,
    display: plan.credential.display.map((d) => ({ name: d.value, locale: d.lang })),
    credential_signing_alg_values_supported: ["ES256"],
    proofTypesSupported: [...PROOF_TYPES_SUPPORTED],
    keyAttestationsRequired: { key_storage: [...KEY_ATTESTATIONS_REQUIRED.key_storage] },
  };
};

/**
 * The engine's numeric status encoding for the Token Status List.
 *
 * `0` valid, `1` revoked, `2` suspended, per IETF Token Status List. The platform never sends `0`
 * after `1` — the domain refuses that transition before this function is reached — but the mapping
 * is total so an unexpected value cannot silently become "valid".
 */
const toEngineStatus = (status: CredentialStatus): number => {
  switch (status) {
    case "VALID":
      return 0;
    case "REVOKED":
      return 1;
    case "SUSPENDED":
      return 2;
    default: {
      const exhaustive: never = status;
      throw PlatformError.engine(
        "unknown_credential_status",
        `Unknown credential status: ${String(exhaustive)}`,
      );
    }
  }
};

/** Re-exported so the composition root can name the claims type without importing the domain. */
export type { SourceAttributes };

/**
 * What a Wallet can learn from a `signed_metadata` JWS without verifying it.
 *
 * Deliberately does not verify the signature: that is a Wallet's job with trust anchors we do not
 * hold, and claiming otherwise would be the kind of false assurance this endpoint exists to avoid.
 * It reports only whether the two things ETSI TS 119 472-3 requires are structurally present —
 * `x5c` in the protected header (`ISS-MDATA-ACC_CERT-4.2.2-01/-02`) and `issuer_info` at the top
 * level of the payload (`ISS-MDATA-REG_CERT-4.2.3-02`).
 *
 * Returns `undefined` for anything that is not a decodable compact JWS, so a malformed value is
 * reported as "not signed" rather than throwing inside a read-only diagnostic endpoint.
 */
export const inspectSignedMetadata = (
  jws: string,
): { hasX5c: boolean; hasIssuerInfo: boolean } | undefined => {
  const parts = jws.split(".");
  if (parts.length !== 3) {
    return undefined;
  }
  const [encodedHeader, encodedPayload] = parts;
  if (encodedHeader === undefined || encodedPayload === undefined) {
    return undefined;
  }
  const header = decodeJsonSegment(encodedHeader);
  const payload = decodeJsonSegment(encodedPayload);
  if (header === undefined || payload === undefined) {
    return undefined;
  }
  const x5c = header["x5c"];
  const issuerInfo = payload["issuer_info"];
  return {
    hasX5c: Array.isArray(x5c) && x5c.length > 0,
    // `ISS-MDATA-REG_CERT-4.2.3-04` says one element **may** carry the registration certificate, so
    // an `issuer_info` array that carries none does not satisfy what gate (a) needs. Checked for the
    // element, not merely for the array.
    hasIssuerInfo:
      Array.isArray(issuerInfo) &&
      issuerInfo.some(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          (entry as Record<string, unknown>)["format"] === "registration_cert",
      ),
  };
};

const decodeJsonSegment = (segment: string): Record<string, unknown> | undefined => {
  try {
    const json = Buffer.from(segment, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};
