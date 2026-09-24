import { createHmac, randomUUID } from "node:crypto";
import { resolvePublishedVersion } from "@edtp/domain";
import type { EudiIssuerPort } from "@edtp/eudi-issuer-port";
import type { IssuanceRepository } from "@edtp/persistence";
import { asId, newCorrelationId, PlatformError } from "@edtp/shared";
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { z } from "zod";
import type { PlatformConfig } from "../config.js";
import type { HostedFormReturns } from "../modules/issuances/hosted-form-returns.js";
import type { IssuanceService } from "../modules/issuances/issuance.service.js";
import type { PresentationService } from "../modules/presentations/presentation.service.js";
import {
  CONFIG_TOKEN,
  HOSTED_FORM_RETURNS,
  ISSUANCE_REPOSITORY,
  ISSUANCE_SERVICE,
  ISSUER_PORT,
  PRESENTATION_SERVICE,
} from "../tokens.js";
import { assertUuidPathParam, constantTimeEquals, Public } from "./auth.js";

/**
 * Wallet-initiated issuance through a hosted form.
 *
 * The wallet starts from its own list of issuers and pushes an authorization request to the protocol
 * engine. The test gateway sends the browser, with that request's opaque reference, to the hosted
 * form instead of the engine's authorization endpoint. The form submits here; the platform validates
 * the values exactly as an operator-form issuance would, holds them in memory, and answers with a
 * pass the gateway checks before letting the browser on to the engine. When the wallet then requests
 * the credential, the engine asks for the values — the second controller below — and receives them
 * once.
 *
 * Neither controller is for a business client, and neither is in the OpenAPI document. Both are
 * `@Public` to the tenant-key guard and check their own secret, because neither caller holds a
 * tenant key: the form holds one secret scoped to the policies configured for it, the engine one key.
 */

export const HOSTED_FORM_SECRET_HEADER = "x-edtp-form-secret";
export const ENGINE_KEY_HEADER = "x-edtp-engine-key";

/**
 * The pass the gateway checks: an HMAC over the engine tenant and the authorization request.
 * `apps/test-gateway` computes the same value; `tests/unit/hosted-form-pass.test.ts` holds them to it.
 */
export const hostedFormAuthorizePass = (
  secret: string,
  engineTenantRef: string,
  requestUri: string,
): string =>
  createHmac("sha256", secret).update(`${engineTenantRef}\n${requestUri}`).digest("base64url");

const submissionSchema = z
  .object({
    /** The engine's opaque reference for the wallet's pushed authorization request. */
    requestUri: z.string().min(8).max(200),
    /** The typed values, for a typed form. Content: validated, held in memory, never persisted. */
    attributes: z.record(z.string().min(1).max(200), z.unknown()).optional(),
    /** Or the verified presentation the person identified with, for the representation flow. */
    presentationId: z.string().uuid().optional(),
  })
  .strict()
  .refine((v) => (v.attributes === undefined) !== (v.presentationId === undefined), {
    message: "Exactly one of attributes or presentationId.",
  });

const requestSchema = z
  .object({
    engineTenantRef: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
    requestUri: z.string().min(8).max(200),
    clientId: z.string().max(200).optional(),
  })
  .strict();

const engineRequestSchema = z
  .object({
    session: z.string().min(1).max(200),
    credential_configuration_id: z.string().min(1).max(300),
  })
  .passthrough();

type Binding = {
  readonly tenantId: string;
  readonly policyId: string;
  readonly identifyPolicyId?: string;
};

@ApiExcludeController()
@Public()
@Controller("v1/hosted-forms")
export class HostedFormController {
  constructor(
    @Inject(CONFIG_TOKEN) private readonly config: PlatformConfig,
    @Inject(ISSUANCE_SERVICE) private readonly issuances: IssuanceService,
    @Inject(ISSUANCE_REPOSITORY) private readonly issuance: IssuanceRepository,
    @Inject(ISSUER_PORT) private readonly issuer: EudiIssuerPort,
    @Inject(PRESENTATION_SERVICE) private readonly presentations: PresentationService,
    @Inject(HOSTED_FORM_RETURNS) private readonly returns: HostedFormReturns,
  ) {}

  /**
   * Which of the form's policies the wallet's pending authorization request asks for. A wallet that
   * lists several credentials from one issuer says which it wants only in that request.
   */
  @Post("requests/resolve")
  @HttpCode(200)
  async resolve(
    @Headers(HOSTED_FORM_SECRET_HEADER) secret: string | undefined,
    @Body() body: unknown,
  ) {
    this.authenticate(secret);
    const input = requestSchema.parse(body);
    const found = await this.issuer.findWalletAuthorizationRequest({
      engineTenantRef: input.engineTenantRef,
      requestUri: input.requestUri,
    });
    const binding = found?.requested
      .map((r) => this.config.HOSTED_FORM_POLICIES.find((b) => b.policyId === r.policyId))
      .find((b): b is Binding => b !== undefined);
    if (!binding) throw PlatformError.notFound("A pending request for a hosted-form policy");
    await this.assertEngineTenant(binding, input.engineTenantRef);
    return { policyId: binding.policyId };
  }

  /**
   * What the form must show: the credential type, the claims a person types (less those the policy
   * fixes), and — for the representation flow — the fixed values it will state, which are the
   * policy's configuration and, in V0, fictitious.
   */
  @Get(":policyId")
  async form(
    @Headers(HOSTED_FORM_SECRET_HEADER) secret: string | undefined,
    @Param("policyId") policyId: string,
  ) {
    const binding = this.authorise(secret, policyId);
    const tenantId = asId<"TenantId">(binding.tenantId);
    const versions = await this.issuance.listVersions(tenantId, policyId);
    const version = resolvePublishedVersion(versions);
    const context = await this.issuance.loadIssuanceContext(tenantId, version.credentialTypeId);
    const fixed = fixedClaimsOf(version.authenticSource.parameters);
    const identify = binding.identifyPolicyId !== undefined;
    return {
      policyId,
      flow: identify ? "identify" : "form",
      engineTenantRef: context.attestationProvider.engineTenantRef,
      credential: { display: context.credentialType.display },
      fields: context.credentialType.claims
        .filter((c) => !(c.path.join(".") in fixed))
        .map((c) => ({
          path: c.path.join("."),
          display: c.display,
          valueType: c.valueType,
          mandatory: c.mandatory,
        })),
      // What the attestation will state on the policy's behalf, shown before the person asks for it.
      ...(identify
        ? {
            fixed: context.credentialType.claims
              .filter((c) => c.path.join(".") in fixed)
              .map((c) => ({
                path: c.path.join("."),
                display: c.display,
                value: fixed[c.path.join(".")],
              })),
          }
        : {}),
    };
  }

  /**
   * Starts the identification step: a same-device presentation of the person's PID, whose return
   * leads back into the form.
   */
  @Post(":policyId/identifications")
  @HttpCode(201)
  async identify(
    @Headers(HOSTED_FORM_SECRET_HEADER) secret: string | undefined,
    @Param("policyId") policyId: string,
    @Body() body: unknown,
  ) {
    const binding = this.authorise(secret, policyId);
    const formUrl = this.config.HOSTED_FORM_PUBLIC_URL;
    if (!binding.identifyPolicyId || !formUrl) {
      throw PlatformError.conflict(
        "hosted_form_identification_not_configured",
        "This policy's hosted form does not identify the person first.",
      );
    }
    const input = requestSchema.parse(body);
    await this.assertEngineTenant(binding, input.engineTenantRef);
    const view = await this.presentations.create({
      tenantId: asId<"TenantId">(binding.tenantId),
      policyId: asId<"PresentationPolicyId">(binding.identifyPolicyId),
      businessReference: "hosted-form-identification",
      interactionType: "SAME_DEVICE",
      correlationId: newCorrelationId(),
    });
    // Back into the form, built here from configuration: the return route looks it up by id.
    const next = new URL("continuar", formUrl.endsWith("/") ? formUrl : `${formUrl}/`);
    next.searchParams.set("tenant", input.engineTenantRef);
    next.searchParams.set("request_uri", input.requestUri);
    if (input.clientId) next.searchParams.set("client_id", input.clientId);
    next.searchParams.set("presentation", view.presentationId);
    this.returns.remember(view.presentationId, next.toString(), view.expiresAt);
    return {
      presentationId: view.presentationId,
      walletUri: view.interaction?.uri,
      expiresAt: view.expiresAt,
    };
  }

  /**
   * The identification's outcome, and — once verified — the identifying claims, for the form to show
   * the person what the attestation will say about them. Content, returned to the page the person is
   * looking at and nowhere else.
   */
  @Get(":policyId/identifications/:presentationId")
  async identification(
    @Headers(HOSTED_FORM_SECRET_HEADER) secret: string | undefined,
    @Param("policyId") policyId: string,
    @Param("presentationId") presentationId: string,
  ) {
    const binding = this.authorise(secret, policyId);
    assertUuidPathParam("presentationId", presentationId);
    const view = await this.presentations.get(
      asId<"TenantId">(binding.tenantId),
      asId<"PresentationId">(presentationId),
      newCorrelationId(),
    );
    if (view.policyId !== binding.identifyPolicyId)
      throw PlatformError.notFound("Identification");
    return {
      status: view.status,
      ...(view.status === "VERIFIED" && view.result ? { claims: view.result.claims } : {}),
    };
  }

  @Post(":policyId/submissions")
  @HttpCode(201)
  async submit(
    @Headers(HOSTED_FORM_SECRET_HEADER) secret: string | undefined,
    @Param("policyId") policyId: string,
    @Body() body: unknown,
  ) {
    const binding = this.authorise(secret, policyId);
    const passSecret = this.config.HOSTED_FORM_AUTHORIZE_SECRET;
    if (!passSecret) {
      throw PlatformError.conflict(
        "hosted_form_not_configured",
        "This deployment cannot hand a hosted form back to the engine.",
      );
    }
    const input = submissionSchema.parse(body);
    if (input.presentationId !== undefined && !binding.identifyPolicyId) {
      throw PlatformError.validation(
        "hosted_form_presentation_not_expected",
        "This policy's hosted form issues from typed values, not from a presentation.",
      );
    }
    const view = await this.issuances.create({
      tenantId: asId<"TenantId">(binding.tenantId),
      policyId,
      // A presentation id is the verified-presentation source's lookup key; a typed form's subject
      // is whoever typed, so it gets a random reference, as the console's operator form does.
      subjectReference: input.presentationId ?? `hosted-form-${randomUUID()}`,
      ...(input.attributes ? { suppliedAttributes: input.attributes } : {}),
      walletAuthorizationRequest: input.requestUri,
    });
    const engineTenantRef = view.walletInitiated?.engineTenantRef;
    if (!engineTenantRef) {
      throw PlatformError.internal("A wallet-initiated issuance returned no engine tenant.");
    }
    return {
      issuanceId: view.issuanceId,
      status: view.status,
      engineTenantRef,
      authorizePass: hostedFormAuthorizePass(passSecret, engineTenantRef, input.requestUri),
      ...(view.warnings ? { warnings: view.warnings } : {}),
    };
  }

  private authenticate(presented: string | undefined): void {
    const expected = this.config.HOSTED_FORM_SECRET;
    if (!expected || !presented || !constantTimeEquals(presented, expected)) {
      throw PlatformError.unauthenticated();
    }
  }

  private authorise(presented: string | undefined, policyId: string): Binding {
    this.authenticate(presented);
    const binding = this.config.HOSTED_FORM_POLICIES.find((b) => b.policyId === policyId);
    if (!binding) {
      throw PlatformError.forbidden(
        "hosted_form_policy_not_allowed",
        "This issuance policy is not open to the hosted form.",
      );
    }
    return binding;
  }

  /** The policy must be issued by the engine tenant the wallet's request went to. */
  private async assertEngineTenant(binding: Binding, engineTenantRef: string): Promise<void> {
    const tenantId = asId<"TenantId">(binding.tenantId);
    const version = resolvePublishedVersion(
      await this.issuance.listVersions(tenantId, binding.policyId),
    );
    const context = await this.issuance.loadIssuanceContext(tenantId, version.credentialTypeId);
    if (context.attestationProvider.engineTenantRef !== engineTenantRef) {
      throw PlatformError.forbidden(
        "hosted_form_tenant_mismatch",
        "The policy is not issued by the issuer this request went to.",
      );
    }
  }
}

export const HOSTED_VERIFIER_SECRET_HEADER = "x-edtp-verifier-secret";

/**
 * The hosted verifier — a demonstration Relying Party page that asks a wallet to present and shows
 * the outcome, used to exercise the platform's attestations the way a customer would.
 *
 * The page is public and holds no tenant key: one secret, accepted only for the presentation policies
 * configured for it. The platform creates the presentation, `SAME_DEVICE`, and decides where the
 * wallet's return goes — the page's configured origin, keyed by presentation id — so neither a visitor
 * nor the page can point that redirect anywhere else.
 */
@ApiExcludeController()
@Public()
@Controller("v1/hosted-verifications")
export class HostedVerifierController {
  constructor(
    @Inject(CONFIG_TOKEN) private readonly config: PlatformConfig,
    @Inject(PRESENTATION_SERVICE) private readonly presentations: PresentationService,
    @Inject(HOSTED_FORM_RETURNS) private readonly returns: HostedFormReturns,
  ) {}

  @Post(":policyId")
  @HttpCode(201)
  async start(
    @Headers(HOSTED_VERIFIER_SECRET_HEADER) secret: string | undefined,
    @Param("policyId") policyId: string,
  ) {
    const binding = this.authorise(secret, policyId);
    const origin = this.config.HOSTED_VERIFIER_PUBLIC_URL;
    if (!origin) {
      throw PlatformError.conflict(
        "hosted_verifier_not_configured",
        "The hosted verifier has no public origin to return the wallet to.",
      );
    }
    const view = await this.presentations.create({
      tenantId: asId<"TenantId">(binding.tenantId),
      policyId: asId<"PresentationPolicyId">(binding.policyId),
      businessReference: "hosted-verifier",
      interactionType: "SAME_DEVICE",
      correlationId: newCorrelationId(),
    });
    const next = new URL("resultado", origin.endsWith("/") ? origin : `${origin}/`);
    next.searchParams.set("policy", binding.policyId);
    next.searchParams.set("presentation", view.presentationId);
    this.returns.remember(view.presentationId, next.toString(), view.expiresAt);
    return {
      presentationId: view.presentationId,
      walletUri: view.interaction?.uri,
      expiresAt: view.expiresAt,
    };
  }

  /**
   * The outcome, and — once verified — the claims the policy's result emits, for the page the person
   * is looking at. Content, returned to that page and nowhere else; the page does not keep it.
   */
  @Get(":policyId/:presentationId")
  async outcome(
    @Headers(HOSTED_VERIFIER_SECRET_HEADER) secret: string | undefined,
    @Param("policyId") policyId: string,
    @Param("presentationId") presentationId: string,
  ) {
    const binding = this.authorise(secret, policyId);
    assertUuidPathParam("presentationId", presentationId);
    const view = await this.presentations.get(
      asId<"TenantId">(binding.tenantId),
      asId<"PresentationId">(presentationId),
      newCorrelationId(),
    );
    if (view.policyId !== binding.policyId) throw PlatformError.notFound("Presentation");
    return {
      status: view.status,
      ...(view.status === "VERIFIED" && view.result ? { claims: view.result.claims } : {}),
      ...(view.failureCode ? { failureCode: view.failureCode } : {}),
    };
  }

  private authorise(presented: string | undefined, policyId: string) {
    const expected = this.config.HOSTED_VERIFIER_SECRET;
    if (!expected || !presented || !constantTimeEquals(presented, expected)) {
      throw PlatformError.unauthenticated();
    }
    assertUuidPathParam("policyId", policyId);
    const binding = this.config.HOSTED_VERIFIER_POLICIES.find((b) => b.policyId === policyId);
    if (!binding) {
      throw PlatformError.forbidden(
        "hosted_verifier_policy_not_allowed",
        "This presentation policy is not open to the hosted verifier.",
      );
    }
    return binding;
  }
}

@ApiExcludeController()
@Public()
@Controller("internal/engine")
export class EngineAttributesController {
  constructor(
    @Inject(CONFIG_TOKEN) private readonly config: PlatformConfig,
    @Inject(ISSUANCE_SERVICE) private readonly issuances: IssuanceService,
  ) {}

  /**
   * The protocol engine's attribute provider call. Answers `{ <configuration id>: claims }`, the
   * shape the engine expects, or 404 when nothing is held — the engine then issues nothing.
   */
  @Post(":engineTenantRef/attributes")
  @HttpCode(200)
  async attributes(
    @Headers(ENGINE_KEY_HEADER) key: string | undefined,
    @Param("engineTenantRef") engineTenantRef: string,
    @Body() body: unknown,
  ) {
    const expected = this.config.ENGINE_ATTRIBUTE_PROVIDER_KEY;
    if (!expected || !key || !constantTimeEquals(key, expected)) {
      throw PlatformError.unauthenticated();
    }
    const input = engineRequestSchema.parse(body);
    const claims = await this.issuances.claimsForEngineSession({
      engineTenantRef,
      engineSessionRef: input.session,
    });
    if (!claims) throw PlatformError.notFound("Held claims for this engine session");
    return { [input.credential_configuration_id]: claims };
  }
}

const fixedClaimsOf = (
  parameters: Readonly<Record<string, unknown>>,
): Record<string, unknown> => {
  const fixed = parameters["fixedClaims"];
  return typeof fixed === "object" && fixed !== null && !Array.isArray(fixed)
    ? (fixed as Record<string, unknown>)
    : {};
};
