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
  }): Promise<void> {
    // The engine exposes status mutation only as a session-keyed call. The platform has already
    // approved the transition in the domain — in particular that `REVOKED` is terminal
    // (`AS-AP-07-007` / `VCR_04`), which the engine itself does **not** enforce.
    await this.client.request(input.session.engineTenantRef, "POST", "/session/revoke", {
      sessionId: input.session.ref,
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

    // 1. The issuance configuration. `authorizationServers` is required with at least one entry,
    //    and `registrationCertificate` is what the engine turns into `issuer_info` in the
    //    Wallet-facing metadata — trust gate (a).
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
    const authorizationServer = plan.eligibilityPresentationPolicyId
      ? {
          type: "oid4vp",
          id: "eligibility-oid4vp",
          presentationConfigId: presentationConfigIdFor(plan.eligibilityPresentationPolicyId),
          enabled: true,
        }
      : // `id` must not be "built-in": the engine reserves that value and answers
        // `Authorization server id 'built-in' is reserved`. A platform-owned name avoids the clash
        // and makes the engine-side object traceable to us.
        { type: "built-in", id: "edtp-issuer-as", enabled: true };

    const issuanceConfig: Record<string, unknown> = {
      authorizationServers: [authorizationServer],
      display: plan.credential.display.map((d) => ({ name: d.value, locale: d.lang })),
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

    return {
      credentialIssuer: metadata.credential_issuer,
      registrationCertificatePresent: registrationCert !== undefined,
      ...(registrationCert?.data ? { registrationCertificateJwt: registrationCert.data } : {}),
      // `signed_metadata` is the OpenID4VCI mechanism a Wallet uses to authenticate the metadata
      // document itself. Reported as observed; the engine at the pinned version does not emit it.
      metadataSigned: typeof metadata.signed_metadata === "string",
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
 */
const credentialConfigId = (plan: IssuancePlan): string =>
  `c-${plan.policyId}-v${plan.policyVersion}`;

/**
 * The engine-side presentation configuration id for a verification policy.
 *
 * Must match what the verifier adapter produces, or the issuance flow would reference a
 * configuration that does not exist. Verification compiles `p-<policyId>-v<version>`; an eligibility
 * presentation always uses version 1 of the named policy, because the stretch goal reuses a policy
 * rather than pinning a version — a decision recorded in `docs/eudiplo-integration.md`.
 */
const presentationConfigIdFor = (presentationPolicyId: string): string =>
  `p-${presentationPolicyId}-v1`;

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
    };
  }
  return {
    format: "mso_mdoc",
    doctype: plan.credential.doctype,
    display: plan.credential.display.map((d) => ({ name: d.value, locale: d.lang })),
    credential_signing_alg_values_supported: ["ES256"],
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
