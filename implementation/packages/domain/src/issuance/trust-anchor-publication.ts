import { PlatformError } from "@edtp/shared";
import type { TrustEnvironment } from "../kernel/trust-environment.js";

/**
 * Publishing the platform's own trust anchors as a list, per ETSI TS 119 602.
 *
 * ## Why this exists, and why it is *not* a notified trust list
 *
 * ARF 3.0.0 §6.3.2.4 describes how a Relying Party obtains trust anchors to verify the signature
 * on a **non-qualified EAA**: from the applicable attestation Rulebook, and *optionally* from
 *
 * > a list of trusted Attestation Providers published by a trusted entity, in accordance with
 * > ETSI TS 119 602
 *
 * The second half is the interesting one. It is **not** governed by Topic 31, which covers the
 * notified lists — PID Providers, PubEAA Providers, WRPAC and WRPRC Providers — whose publication
 * is a Member State function the platform has no part in. A non-qualified EAA Provider list is an
 * ordinary ETSI TS 119 602 publication by "a trusted entity", and a platform operating Attestation
 * Providers can be that entity for its own types.
 *
 * So this capability is in scope and the notified lists are not. Keeping that distinction visible
 * is the point of the `trustEnvironment` field and of `assertPublishable` below.
 *
 * ## What V0 may and may not do
 *
 * **`TEST` only.** A `PRODUCTION` publication would be a standing trust assertion that other
 * parties could rely on, and making one requires governance the platform does not have in V0:
 * a published practice statement, key ceremony, audited custody of the signing key, a revocation
 * story, and the legal qualification of the hosted-instance profile that is still open (Q2).
 * `assertPublishable` refuses it structurally rather than leaving it to reviewer discipline.
 *
 * Every `TEST` publication is labelled in the list itself — see `TEST_SCHEME_NAME_PREFIX` — so a
 * consumer that fetches it cannot mistake it for a notified list.
 *
 * ## Relationship to a wallet test
 *
 * A published list is what makes the *faithful* wallet configuration possible: populating the
 * Reference Wallet's `eaaProviders` map and declaring `eaas` in its classifications exercises the
 * real §6.3.2.4 code path, where downgrading the trust policy to `INFORM` merely bypasses it. That
 * is still a **modified** wallet under `CLAUDE.md` §8, and the wallet modification is deliberately
 * not built here. See `docs/issuer-trust-model.md`.
 */

/** Prefix every `TEST` scheme name carries, so a fetched list is self-describing. */
export const TEST_SCHEME_NAME_PREFIX = "TEST ONLY — NOT A NOTIFIED TRUST LIST — ";

/** The ETSI TS 119 602 service type for issuing an attestation. */
export const SERVICE_TYPE_ATTESTATION_ISSUANCE =
  "http://uri.etsi.org/TrstSvc/Svctype/EUDIW/Attestation/Issuance";

export const SERVICE_STATUSES = ["granted", "withdrawn"] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

/** One Attestation Provider's anchor, as it appears in the list. */
export interface PublishedTrustAnchor {
  /** The Attestation Provider whose anchor this is. */
  readonly attestationProviderId: string;
  /** Human-readable service name, shown by a consumer that displays list contents. */
  readonly serviceName: string;
  /** The anchor certificate, base64 DER — the ETSI `X509Certificate` `val` encoding. */
  readonly certificateDer: string;
  /**
   * The attestation types this anchor is good for, as `vct` values or mdoc doctypes.
   *
   * Scoping an anchor to the types it actually issues is what stops a list from becoming a
   * blanket authorisation: a consumer can check that the attestation it holds is one this
   * provider was listed for.
   */
  readonly attestationTypes: readonly string[];
  readonly status: ServiceStatus;
  /** When the status last changed, which ETSI requires alongside the status. */
  readonly statusStartingTime: Date;
}

export interface TrustAnchorPublication {
  readonly id: string;
  readonly tenantId: string;
  readonly trustEnvironment: TrustEnvironment;
  /** Scheme operator name — the "trusted entity" of §6.3.2.4. */
  readonly schemeOperatorName: string;
  /** Where the signed list is served. Consumers fetch this. */
  readonly publicationUri: string;
  readonly sequenceNumber: number;
  readonly issuedAt: Date;
  /**
   * When consumers should refetch.
   *
   * Not cosmetic: the dev lists roll over, and a consumer honouring `NextUpdate` is the mechanism
   * by which a withdrawn anchor stops being trusted. A publication whose `nextUpdate` has passed
   * must be treated as stale by anything reading it.
   */
  readonly nextUpdate: Date;
  readonly anchors: readonly PublishedTrustAnchor[];
  /** Opaque reference to the key that signs the list. The platform never holds the key itself. */
  readonly signingKeyRef: string;
  readonly createdAt: Date;
}

/**
 * Refuses a publication that must not be made.
 *
 * Separate from the generic validation so the `PRODUCTION` refusal is impossible to miss and
 * impossible to skip: it is not one failed rule among many, it is a different kind of answer.
 */
export const assertPublishable = (input: {
  readonly trustEnvironment: TrustEnvironment;
  readonly anchors: readonly PublishedTrustAnchor[];
  readonly schemeOperatorName: string;
  readonly publicationUri: string;
  readonly issuedAt: Date;
  readonly nextUpdate: Date;
}): void => {
  if (input.trustEnvironment !== "TEST") {
    throw PlatformError.conflict(
      "trust_anchor_publication_test_only",
      "V0 may publish a TEST trust-anchor list only. A PRODUCTION publication is a standing " +
        "trust assertion that third parties could rely on, and making one requires governance " +
        "this platform does not have: a published practice statement, audited key custody, a " +
        "revocation process, and the unresolved legal qualification of the hosted-instance " +
        "profile. Refused structurally rather than by convention.",
    );
  }

  const details: { path: string; code: string; message: string }[] = [];

  if (input.anchors.length === 0) {
    details.push({
      path: "anchors",
      code: "anchors_required",
      message: "A trust-anchor list with no anchors asserts nothing; refusing to publish it.",
    });
  }
  if (!input.schemeOperatorName.trim()) {
    details.push({
      path: "schemeOperatorName",
      code: "scheme_operator_required",
      message:
        "ETSI TS 119 602 requires a scheme operator: the 'trusted entity' of ARF §6.3.2.4 that " +
        "a consumer decides whether to trust.",
    });
  }
  if (!input.publicationUri.startsWith("https://")) {
    details.push({
      path: "publicationUri",
      code: "publication_uri_insecure",
      message: "A trust-anchor list must be published over HTTPS.",
    });
  }
  if (input.nextUpdate.getTime() <= input.issuedAt.getTime()) {
    details.push({
      path: "nextUpdate",
      code: "next_update_invalid",
      message: "NextUpdate must be after the issue time, or the list is stale on publication.",
    });
  }
  for (const [i, anchor] of input.anchors.entries()) {
    if (anchor.attestationTypes.length === 0) {
      details.push({
        path: `anchors[${i}].attestationTypes`,
        code: "attestation_types_required",
        message:
          "An anchor must name the attestation types it is listed for. An unscoped anchor is a " +
          "blanket authorisation, which is what scoping exists to prevent.",
      });
    }
    if (!anchor.certificateDer.trim()) {
      details.push({
        path: `anchors[${i}].certificateDer`,
        code: "anchor_certificate_required",
        message: "An anchor must carry its certificate.",
      });
    }
  }

  if (details.length > 0) {
    throw PlatformError.unprocessable(
      "trust_anchor_publication_invalid",
      "The trust-anchor publication is not valid.",
      details,
    );
  }
};

/**
 * The list body, in ETSI TS 119 602 shape, ready to be signed.
 *
 * Returned as a plain object rather than a signed JWT because signing belongs to whatever holds
 * the key, not to the domain. The domain's job is to decide *what* is asserted.
 *
 * The structure mirrors the dev LoTEs the platform already consumes — `LoTE`,
 * `ListAndSchemeInformation`, `TrustedEntitiesList`, `ServiceDigitalIdentity.X509Certificates` —
 * so the same reader works on both, which is the cheapest way to keep producer and consumer
 * honest about the format.
 */
export const buildTrustAnchorListBody = (
  publication: TrustAnchorPublication,
): Record<string, unknown> => {
  assertPublishable(publication);

  return {
    LoTE: {
      ListAndSchemeInformation: {
        // The label rides inside the signed payload, so it cannot be stripped in transit.
        SchemeName: [
          { lang: "en", value: `${TEST_SCHEME_NAME_PREFIX}${publication.schemeOperatorName}` },
        ],
        SchemeOperatorName: [{ lang: "en", value: publication.schemeOperatorName }],
        ListIssueDateTime: publication.issuedAt.toISOString(),
        NextUpdate: publication.nextUpdate.toISOString(),
        ListSequenceNumber: publication.sequenceNumber,
        DistributionPoints: [publication.publicationUri],
        // Not a notified list, stated in the payload as well as the scheme name.
        SchemeTypeCommunityRules: [
          {
            lang: "en",
            value:
              "Published under ARF 3.0.0 §6.3.2.4 as an optional list of trusted Attestation " +
              "Providers for non-qualified EAAs. NOT a list notified under Topic 31, and not a " +
              "PID, PubEAA, WRPAC or WRPRC Providers list. TEST environment only.",
          },
        ],
      },
      TrustedEntitiesList: publication.anchors.map((anchor) => ({
        TrustedEntityServices: [
          {
            ServiceInformation: {
              ServiceTypeIdentifier: SERVICE_TYPE_ATTESTATION_ISSUANCE,
              ServiceName: [{ lang: "en", value: anchor.serviceName }],
              ServiceStatus: anchor.status,
              StatusStartingTime: anchor.statusStartingTime.toISOString(),
              ServiceDigitalIdentity: {
                X509Certificates: [{ val: anchor.certificateDer }],
              },
              // The type scoping, in an extension rather than a core field: ETSI TS 119 602 has
              // no standard place for "which attestation types this provider issues", so it goes
              // in a namespaced extension and is documented as a platform convention.
              ServiceInformationExtensions: [
                {
                  Critical: false,
                  AttestationTypes: [...anchor.attestationTypes],
                },
              ],
            },
          },
        ],
      })),
    },
  };
};

/** True when a publication should be refetched. Used by consumers and by the retention job. */
export const isPublicationStale = (publication: TrustAnchorPublication, at: Date): boolean =>
  publication.nextUpdate.getTime() <= at.getTime();
