import { createHmac, randomUUID } from "node:crypto";
import { resolvePublishedVersion } from "@edtp/domain";
import type { IssuanceRepository } from "@edtp/persistence";
import { asId, PlatformError } from "@edtp/shared";
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { z } from "zod";
import type { PlatformConfig } from "../config.js";
import type { IssuanceService } from "../modules/issuances/issuance.service.js";
import { CONFIG_TOKEN, ISSUANCE_REPOSITORY, ISSUANCE_SERVICE } from "../tokens.js";
import { constantTimeEquals, Public } from "./auth.js";

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
    /** The typed values. Content: validated, held in memory, never persisted or logged. */
    attributes: z.record(z.string().min(1).max(200), z.unknown()),
  })
  .strict();

const engineRequestSchema = z
  .object({
    session: z.string().min(1).max(200),
    credential_configuration_id: z.string().min(1).max(300),
  })
  .passthrough();

@ApiExcludeController()
@Public()
@Controller("v1/hosted-forms")
export class HostedFormController {
  constructor(
    @Inject(CONFIG_TOKEN) private readonly config: PlatformConfig,
    @Inject(ISSUANCE_SERVICE) private readonly issuances: IssuanceService,
    @Inject(ISSUANCE_REPOSITORY) private readonly issuance: IssuanceRepository,
  ) {}

  /**
   * What the form must ask for: the credential type's claims, less those the policy fixes. Read from
   * the credential type rather than written into the form, so the form cannot drift from what the
   * platform will accept.
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
    return {
      policyId,
      credential: { display: context.credentialType.display },
      fields: context.credentialType.claims
        .filter((c) => !(c.path.join(".") in fixed))
        .map((c) => ({
          path: c.path.join("."),
          display: c.display,
          valueType: c.valueType,
          mandatory: c.mandatory,
        })),
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
    const view = await this.issuances.create({
      tenantId: asId<"TenantId">(binding.tenantId),
      policyId,
      // A random reference, as the console's operator form sends: the subject is whoever typed.
      subjectReference: `hosted-form-${randomUUID()}`,
      suppliedAttributes: input.attributes,
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

  private authorise(
    presented: string | undefined,
    policyId: string,
  ): { readonly tenantId: string; readonly policyId: string } {
    const expected = this.config.HOSTED_FORM_SECRET;
    if (!expected || !presented || !constantTimeEquals(presented, expected)) {
      throw PlatformError.unauthenticated();
    }
    const binding = this.config.HOSTED_FORM_POLICIES.find((b) => b.policyId === policyId);
    if (!binding) {
      throw PlatformError.forbidden(
        "hosted_form_policy_not_allowed",
        "This issuance policy is not open to the hosted form.",
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
