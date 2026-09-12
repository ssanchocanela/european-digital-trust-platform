import type { TenantId } from "@edtp/shared";
import { and, desc, eq, lt, or, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { Database } from "../db.js";
import { type Page, type PageRequest, toPage } from "../pagination.js";
import {
  attestationProviders,
  credentialTypes,
  intendedUses,
  issuancePolicies,
  issuanceTransactions,
  issuedCredentials,
  organisations,
  presentationPolicies,
  presentationTransactions,
  relyingPartyServices,
} from "../schema.js";

/**
 * The list endpoints' reads.
 *
 * ## A list is a different exposure from a read, and is treated as one
 *
 * Until now a caller needed an identifier to see anything: `POST` returned one, `GET` took one. A list
 * route makes **enumeration** possible for the first time, which is a deliberate widening rather than a
 * convenience — `docs/web-interface-proposal.md` §5 says so, and the tenant-isolation suite now asserts
 * that enumeration is scoped, not only that direct access is.
 *
 * Two rules follow, and they are enforced here rather than left to each caller:
 *
 * 1. **Every query is scoped by `tenantId` in its `WHERE`.** Not filtered afterwards, not scoped by the
 *    caller — the repository takes a `TenantId` and there is no method that omits it.
 * 2. **A presentation list item carries no result.** `GET /v1/presentations/{id}` returns the result
 *    policy's output; the list returns metadata only. Enumerating transactions is a reasonable
 *    operational need; enumerating *results* is a bulk read of the most sensitive thing the API emits,
 *    and `AS-RP-01-002` (`OIA_16`) binds the platform as the Relying Party Instance. Anyone who wants a
 *    result asks for it one identifier at a time, which is a different and auditable act.
 */

/** What a presentation looks like in a list. Deliberately not `PresentationView`: no `result` field. */
export interface PresentationListItem {
  readonly presentationId: string;
  readonly businessReference: string;
  readonly status: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly interactionType: string;
  readonly failureCode?: string;
  readonly sentWithoutRegistrationCertificate: boolean;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly closedAt?: Date;
}

export interface IssuanceListItem {
  readonly issuanceId: string;
  /** Optional because the column is nullable: an issuance may be started without a caller reference. */
  readonly businessReference?: string;
  readonly status: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly credentialTypeId: string;
  readonly failureCode?: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface IssuedCredentialListItem {
  readonly issuedCredentialId: string;
  readonly credentialTypeId: string;
  readonly status: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  /**
   * When the status last changed, not "when it was revoked".
   *
   * The column records any transition — revocation, suspension, reinstatement — and naming it
   * `revokedAt` would assert a reason the row does not carry. `status` says what it is now.
   */
  readonly statusChangedAt?: Date;
}

export interface NamedListItem {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export class ListingRepository {
  constructor(private readonly db: Database) {}

  async organisations(tenantId: TenantId, page: PageRequest): Promise<Page<NamedListItem>> {
    const rows = await this.keyset(organisations, organisations.createdAt, tenantId, page);
    return toPage(
      rows.map((r) => ({
        id: r.id,
        name: r.legalName,
        createdAt: r.createdAt,
        detail: { memberState: r.memberState, isPublicSectorBody: r.isPublicSectorBody },
      })),
      page.limit,
      keyOf,
    );
  }

  async relyingPartyServices(
    tenantId: TenantId,
    page: PageRequest,
  ): Promise<Page<NamedListItem>> {
    const rows = await this.keyset(
      relyingPartyServices,
      relyingPartyServices.createdAt,
      tenantId,
      page,
    );
    return toPage(
      rows.map((r) => ({
        id: r.id,
        name: r.serviceTradeName,
        createdAt: r.createdAt,
        detail: {
          serviceIdentifier: r.serviceIdentifier,
          // Whether a callback destination exists, not what it is: the allow-list is configuration a
          // list does not need to reproduce.
          hasWebhookEndpoint: r.webhookEndpointId !== null,
        },
      })),
      page.limit,
      keyOf,
    );
  }

  async intendedUses(
    tenantId: TenantId,
    relyingPartyServiceId: string,
    page: PageRequest,
  ): Promise<Page<NamedListItem>> {
    const rows = await this.keyset(intendedUses, intendedUses.createdAt, tenantId, page, [
      eq(intendedUses.relyingPartyServiceId, relyingPartyServiceId),
    ]);
    return toPage(
      rows.map((r) => ({
        id: r.id,
        name: r.intendedUseIdentifier,
        createdAt: r.createdAt,
        detail: { registeredCredentials: r.registeredCredentials },
      })),
      page.limit,
      keyOf,
    );
  }

  async presentationPolicies(
    tenantId: TenantId,
    page: PageRequest,
  ): Promise<Page<NamedListItem>> {
    const rows = await this.keyset(
      presentationPolicies,
      presentationPolicies.createdAt,
      tenantId,
      page,
    );
    return toPage(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        createdAt: r.createdAt,
        detail: { intendedUseId: r.intendedUseId },
      })),
      page.limit,
      keyOf,
    );
  }

  async presentations(
    tenantId: TenantId,
    page: PageRequest,
  ): Promise<Page<PresentationListItem>> {
    const rows = await this.keyset(
      presentationTransactions,
      presentationTransactions.createdAt,
      tenantId,
      page,
    );
    return toPage(
      // Selected field by field rather than spread, so a column added to the table later cannot appear
      // in a list response without someone deciding that it should.
      rows.map((r) => ({
        presentationId: r.id,
        businessReference: r.businessReference,
        status: r.state,
        policyId: r.policyId,
        policyVersion: r.policyVersion,
        interactionType: r.interactionType,
        ...(r.failureCode ? { failureCode: r.failureCode } : {}),
        sentWithoutRegistrationCertificate: r.sentWithoutRegistrationCertificate,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        ...(r.closedAt ? { closedAt: r.closedAt } : {}),
      })),
      page.limit,
      (item) => ({ createdAt: item.createdAt, id: item.presentationId }),
    );
  }

  async attestationProviders(
    tenantId: TenantId,
    page: PageRequest,
  ): Promise<Page<NamedListItem>> {
    const rows = await this.keyset(
      attestationProviders,
      attestationProviders.createdAt,
      tenantId,
      page,
    );
    return toPage(
      rows.map((r) => ({
        id: r.id,
        name: r.registrarAssignedIdentifier,
        createdAt: r.createdAt,
        detail: {
          trustEnvironment: r.trustEnvironment,
          provisioned: r.engineTenantRef !== null,
        },
      })),
      page.limit,
      keyOf,
    );
  }

  async credentialTypes(tenantId: TenantId, page: PageRequest): Promise<Page<NamedListItem>> {
    const rows = await this.keyset(credentialTypes, credentialTypes.createdAt, tenantId, page);
    return toPage(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        createdAt: r.createdAt,
        detail: {
          format: r.format,
          vct: r.vct,
          attestationProviderId: r.attestationProviderId,
        },
      })),
      page.limit,
      keyOf,
    );
  }

  async issuancePolicies(tenantId: TenantId, page: PageRequest): Promise<Page<NamedListItem>> {
    const rows = await this.keyset(
      issuancePolicies,
      issuancePolicies.createdAt,
      tenantId,
      page,
    );
    return toPage(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        createdAt: r.createdAt,
        detail: { credentialTypeId: r.credentialTypeId },
      })),
      page.limit,
      keyOf,
    );
  }

  async issuances(tenantId: TenantId, page: PageRequest): Promise<Page<IssuanceListItem>> {
    const rows = await this.keyset(
      issuanceTransactions,
      issuanceTransactions.createdAt,
      tenantId,
      page,
    );
    return toPage(
      rows.map((r) => ({
        issuanceId: r.id,
        status: r.state,
        policyId: r.policyId,
        policyVersion: r.policyVersion,
        credentialTypeId: r.credentialTypeId,
        ...(r.businessReference ? { businessReference: r.businessReference } : {}),
        ...(r.failureCode ? { failureCode: r.failureCode } : {}),
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
      })),
      page.limit,
      (item) => ({ createdAt: item.createdAt, id: item.issuanceId }),
    );
  }

  async issuedCredentials(
    tenantId: TenantId,
    page: PageRequest,
  ): Promise<Page<IssuedCredentialListItem>> {
    // Sorted by `issued_at`: this is the one listable table with no `created_at`, and inventing an
    // alias for it would hide that from anyone reading the query plan.
    const rows = await this.keyset(
      issuedCredentials,
      issuedCredentials.issuedAt,
      tenantId,
      page,
    );
    return toPage(
      rows.map((r) => ({
        issuedCredentialId: r.id,
        credentialTypeId: r.credentialTypeId,
        status: r.status,
        issuedAt: r.issuedAt,
        expiresAt: r.expiresAt,
        ...(r.statusChangedAt ? { statusChangedAt: r.statusChangedAt } : {}),
        // `engineSessionRef`, `statusListUri` and `statusListIndex` are deliberately absent. The
        // revocation index is an `ISSU_35` unique element, and the session reference is metadata that
        // must never be returned or logged (`CLAUDE.md` §6.8).
      })),
      page.limit,
      (item) => ({ createdAt: item.issuedAt, id: item.issuedCredentialId }),
    );
  }

  /**
   * The keyset query every list shares.
   *
   * Ordered by `(sort column DESC, id DESC)`. The id is not decoration: a timestamp is not unique — two
   * rows written in the same millisecond are ordinary — and a non-unique sort key makes pagination drop
   * or repeat rows at a page boundary, which is the bug this whole file exists to avoid.
   *
   * Fetches `limit + 1` so the caller can tell whether a next page exists without a `COUNT`.
   *
   * The sort column is passed explicitly at every call site rather than defaulted. `issued_credentials`
   * is keyed on `issued_at` and every other table on `created_at`, and a default would either exclude
   * that table from the type or hide the difference from whoever reads a query plan. Ten repetitions of
   * `table.createdAt` is a fair price for each query stating its own order.
   */
  private async keyset<T extends ListableTable>(
    table: T,
    sortColumn: PgColumn,
    tenantId: TenantId,
    page: PageRequest,
    extra: readonly SQL[] = [],
  ): Promise<readonly T["$inferSelect"][]> {
    const conditions: SQL[] = [eq(table.tenantId, tenantId), ...extra];
    if (page.cursor) {
      // Strictly "after" the cursor row in the sort order. Compared on the pair rather than on the
      // timestamp alone, or rows sharing a timestamp with the cursor would be skipped.
      const afterCursor = or(
        lt(sortColumn, page.cursor.createdAt),
        and(eq(sortColumn, page.cursor.createdAt), lt(table.id, page.cursor.id)),
      );
      if (afterCursor) {
        conditions.push(afterCursor);
      }
    }

    return (await this.db
      .select()
      .from(table as PgTable)
      .where(and(...conditions))
      .orderBy(desc(sortColumn), desc(table.id))
      .limit(page.limit + 1)) as readonly T["$inferSelect"][];
  }
}

/**
 * What `keyset` needs from a table: an id, a tenant, and a default sort column.
 *
 * Declared so the method is one implementation rather than ten near-identical ones, and so a table
 * missing any of the three is a compile error rather than a runtime surprise.
 */
type ListableTable = PgTable & {
  readonly id: PgColumn;
  readonly tenantId: PgColumn;
};

const keyOf = (item: NamedListItem) => ({ createdAt: item.createdAt, id: item.id });

/** Exposed for the migration test, which asserts the supporting indexes exist. */
export const PAGINATED_TABLES: readonly string[] = [
  "organisations",
  "relying_party_services",
  "intended_uses",
  "presentation_policies",
  "presentation_transactions",
  "attestation_providers",
  "credential_types",
  "issuance_policies",
  "issuance_transactions",
  "issued_credentials",
];
