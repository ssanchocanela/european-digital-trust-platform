import type { StatusCheckMode, TrustAnchorSource, VerificationPlan } from "@edtp/domain";
import { PlatformError } from "@edtp/shared";
import type { EngineClient } from "./client.js";
import { buildDcqlQuery, toEngineStatusCheckMode } from "./dcql.js";

/**
 * The engine's presentation configuration body, built in one place.
 *
 * Two callers need it and they are not the same party. The **verifier** adapter writes it for a
 * Relying Party Instance, signed with that Relying Party's access certificate. The **issuer**
 * adapter writes it for an Attestation Provider gating issuance on a presentation (§7.3), signed
 * with the *provider's* access certificate and on the provider's own engine tenant.
 *
 * Keeping it one function is not tidiness. `interop-findings.md` A22 is what happened when the
 * issuer referenced a configuration only the verifier ever wrote: it resolved on a development stack
 * where one engine tenant served both roles, and nowhere else. Two builders would let the two bodies
 * drift into requesting different things under the same policy id.
 */
export interface PresentationConfigInput {
  readonly configId: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly credentialRequirement: VerificationPlan["credentialRequirement"];
  readonly requestedClaims: VerificationPlan["requestedClaims"];
  readonly statusCheckMode: StatusCheckMode;
  readonly anchorSources: readonly TrustAnchorSource[];
  /** Anchor source `ref` → id of the engine-held list built from it, on this engine tenant. */
  readonly issuerTrustLists: Readonly<Record<string, string>>;
  /** The access key chain **on the engine tenant this is being written to**. */
  readonly accessKeyChainId: string;
  readonly registrationCertificateJwt?: string;
}

export const buildPresentationConfigBody = (
  input: PresentationConfigInput,
): Record<string, unknown> => {
  const body: Record<string, unknown> = {
    id: input.configId,
    // The engine's own documentation notes this description is not shown to the end user. The
    // user-facing text is the registration certificate's `purpose`.
    description: `Platform policy ${input.policyId} version ${input.policyVersion}`,
    dcql_query: buildDcqlQuery(input),
    statusCheckMode: toEngineStatusCheckMode(input.statusCheckMode),
    accessKeyChainId: input.accessKeyChainId,
  };
  if (input.registrationCertificateJwt) {
    // `registrationCertImportJwt` attaches a certificate we already hold, with no registrar call to
    // issue one. The field name and its type were both wrong once — `registrationCert: { jwt }` is
    // rejected outright by `PresentationConfigCreateDto`, which declares `additionalProperties:
    // false`, and the engine's OpenAPI document declares this field as an array while its zod
    // validator wants a string. `docs/interop-findings.md` A12.
    body.registrationCertImportJwt = input.registrationCertificateJwt;
  }
  // With no registration certificate the request goes without one. V0 has no reachable provider
  // (blocker B3); the omission is reported upward, never faked.
  return body;
};

/**
 * Confirms every issuer trust list a configuration body names is loaded on the engine tenant.
 *
 * The engine would otherwise accept the configuration and fail only when a wallet presents, with an
 * error that names nothing a customer can act on. Lists are per engine tenant, so a list loaded for
 * one Relying Party Instance does not exist for another.
 */
export const assertIssuerTrustListsLoaded = async (
  client: EngineClient,
  engineTenantRef: string,
  body: Record<string, unknown>,
): Promise<void> => {
  const query = body.dcql_query as { credentials: { trusted_authorities?: unknown }[] };
  const ids = new Set<string>();
  for (const credential of query.credentials) {
    for (const authority of (credential.trusted_authorities ?? []) as {
      values: { trustListId: string }[];
    }[]) {
      for (const value of authority.values) ids.add(value.trustListId);
    }
  }
  if (ids.size === 0) return;
  const loaded = new Set(
    (
      (await client.request<{ id?: unknown }[]>(engineTenantRef, "GET", "/trust-list")) ?? []
    ).map((list) => list.id),
  );
  for (const id of ids) {
    if (!loaded.has(id)) {
      throw PlatformError.validation(
        "trust_anchor_source_not_provisioned",
        "A trust anchor source the policy names is not loaded for this service. " +
          "Load it with scripts/load-issuer-trust-list.mjs.",
      );
    }
  }
};
