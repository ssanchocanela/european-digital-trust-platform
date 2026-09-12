import type { ListingRepository, Page } from "@edtp/persistence";
import { parsePageRequest } from "@edtp/persistence";
import { asId } from "@edtp/shared";
import { Controller, Get, Inject, Param, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { AuditService } from "../modules/audit/audit.service.js";
import { AUDIT_SERVICE, LISTING_REPOSITORY } from "../tokens.js";
import { assertTenantMatches, assertUuidPathParam, Ctx, type RequestContext } from "./auth.js";

/**
 * The list endpoints.
 *
 * ## Why these are a separate controller
 *
 * Not tidiness. Until now every route took an identifier the caller already held, so a caller could
 * read only what they had been told about. These routes make **enumeration** possible, which is a
 * deliberate widening of what the API exposes rather than a convenience added for a screen — see
 * `docs/web-interface-proposal.md` §5. Keeping them together means the decision is reviewable in one
 * file instead of scattered across the controllers that already existed.
 *
 * ## What a list may contain
 *
 * Metadata. **A presentation list carries no result**, and a credential list carries no status-list
 * index or engine session reference. `GET /v1/presentations/{id}` still returns the result policy's
 * output, one identifier at a time — enumerating results in bulk is a different act, and
 * `AS-RP-01-002` (`OIA_16`) binds the platform as the Relying Party Instance. The shapes are defined in
 * `ListingRepository`, which selects field by field so a column added later cannot appear here by
 * accident.
 *
 * Every query is scoped by the authenticated tenant. The `tenantId` in the path is checked against the
 * credential and never trusted (`CLAUDE.md` §9), exactly as everywhere else.
 */

/** The wire shape. `nextCursor` is absent on the last page rather than `null`. */
const toPageResponse = <T>(page: Page<T>): Record<string, unknown> => ({
  items: page.items,
  ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
});

@ApiTags("Listing")
@Controller("v1/tenants")
export class TenantListingController {
  constructor(@Inject(LISTING_REPOSITORY) private readonly listing: ListingRepository) {}

  @Get(":tenantId/organisations")
  @ApiOperation({ summary: "List organisations" })
  async organisations(
    @Ctx() ctx: RequestContext,
    @Param("tenantId") tenantId: string,
    @Query() query: Record<string, unknown>,
  ) {
    const id = assertTenantMatches(ctx, tenantId);
    return toPageResponse(await this.listing.organisations(id, parsePageRequest(query)));
  }

  @Get(":tenantId/rp-services")
  @ApiOperation({ summary: "List Relying Party Services" })
  async relyingPartyServices(
    @Ctx() ctx: RequestContext,
    @Param("tenantId") tenantId: string,
    @Query() query: Record<string, unknown>,
  ) {
    const id = assertTenantMatches(ctx, tenantId);
    return toPageResponse(await this.listing.relyingPartyServices(id, parsePageRequest(query)));
  }

  @Get(":tenantId/rp-services/:serviceId/intended-uses")
  @ApiOperation({ summary: "List the intended uses of one Relying Party Service" })
  async intendedUses(
    @Ctx() ctx: RequestContext,
    @Param("tenantId") tenantId: string,
    @Param("serviceId") serviceId: string,
    @Query() query: Record<string, unknown>,
  ) {
    const id = assertTenantMatches(ctx, tenantId);
    assertUuidPathParam("serviceId", serviceId);
    // Scoped by tenant *and* service. A service id belonging to another tenant simply matches nothing,
    // rather than being rejected — which is the right answer: confirming that an id exists elsewhere
    // would itself be a cross-tenant disclosure.
    return toPageResponse(
      await this.listing.intendedUses(id, serviceId, parsePageRequest(query)),
    );
  }

  @Get(":tenantId/presentation-policies")
  @ApiOperation({ summary: "List presentation policies" })
  async presentationPolicies(
    @Ctx() ctx: RequestContext,
    @Param("tenantId") tenantId: string,
    @Query() query: Record<string, unknown>,
  ) {
    const id = assertTenantMatches(ctx, tenantId);
    return toPageResponse(await this.listing.presentationPolicies(id, parsePageRequest(query)));
  }

  @Get(":tenantId/attestation-providers")
  @ApiOperation({ summary: "List Attestation Providers" })
  async attestationProviders(
    @Ctx() ctx: RequestContext,
    @Param("tenantId") tenantId: string,
    @Query() query: Record<string, unknown>,
  ) {
    const id = assertTenantMatches(ctx, tenantId);
    return toPageResponse(await this.listing.attestationProviders(id, parsePageRequest(query)));
  }

  @Get(":tenantId/credential-types")
  @ApiOperation({ summary: "List credential types" })
  async credentialTypes(
    @Ctx() ctx: RequestContext,
    @Param("tenantId") tenantId: string,
    @Query() query: Record<string, unknown>,
  ) {
    const id = assertTenantMatches(ctx, tenantId);
    return toPageResponse(await this.listing.credentialTypes(id, parsePageRequest(query)));
  }

  @Get(":tenantId/issuance-policies")
  @ApiOperation({ summary: "List issuance policies" })
  async issuancePolicies(
    @Ctx() ctx: RequestContext,
    @Param("tenantId") tenantId: string,
    @Query() query: Record<string, unknown>,
  ) {
    const id = assertTenantMatches(ctx, tenantId);
    return toPageResponse(await this.listing.issuancePolicies(id, parsePageRequest(query)));
  }
}

@ApiTags("Listing")
@Controller("v1")
export class TransactionListingController {
  constructor(
    @Inject(LISTING_REPOSITORY) private readonly listing: ListingRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {}

  @Get("presentations")
  @ApiOperation({ summary: "List presentation transactions. Metadata only — never a result" })
  async presentations(@Ctx() ctx: RequestContext, @Query() query: Record<string, unknown>) {
    return toPageResponse(
      await this.listing.presentations(ctx.tenantId, parsePageRequest(query)),
    );
  }

  @Get("issuances")
  @ApiOperation({ summary: "List issuance transactions" })
  async issuances(@Ctx() ctx: RequestContext, @Query() query: Record<string, unknown>) {
    return toPageResponse(await this.listing.issuances(ctx.tenantId, parsePageRequest(query)));
  }

  @Get("issued-credentials")
  @ApiOperation({
    summary: "List issued attestations. No status-list index, no engine reference",
  })
  async issuedCredentials(@Ctx() ctx: RequestContext, @Query() query: Record<string, unknown>) {
    return toPageResponse(
      await this.listing.issuedCredentials(ctx.tenantId, parsePageRequest(query)),
    );
  }

  /**
   * One presentation's audit trail.
   *
   * `AuditService.listForPresentation` existed and no route exposed it, so the evidence the platform
   * records was only reachable by reading the database — which `CLAUDE.md` §5 forbids doing to the
   * engine's, and which is a poor way to reach our own.
   *
   * Audit rows record *that* something happened, under which policy version, with what outcome. The
   * repository redacts `detail` on write with the same deny-list the logger uses, so this route cannot
   * become a second way to read content.
   *
   * Not paginated: a presentation's trail is a handful of events, bounded by its own lifecycle. A list
   * that cannot grow without bound does not need a cursor, and adding one would imply it might.
   */
  @Get("presentations/:presentationId/audit")
  @ApiOperation({ summary: "The audit trail of one presentation. Evidence, never content" })
  async presentationAudit(
    @Ctx() ctx: RequestContext,
    @Param("presentationId") presentationId: string,
  ) {
    assertUuidPathParam("presentationId", presentationId);
    const events = await this.audit.listForPresentation(
      ctx.tenantId,
      asId<"PresentationId">(presentationId),
    );
    return {
      presentationId,
      events: events.map((event) => ({
        at: event.at.toISOString(),
        actor: event.actor,
        action: event.action,
        ...(event.outcome ? { outcome: event.outcome } : {}),
        ...(event.policyId ? { policyId: event.policyId } : {}),
        ...(event.policyVersion !== undefined ? { policyVersion: event.policyVersion } : {}),
        ...(event.correlationId ? { correlationId: event.correlationId } : {}),
        ...(event.detail ? { detail: event.detail } : {}),
      })),
    };
  }
}
