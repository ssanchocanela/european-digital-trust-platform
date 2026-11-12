import { createHash } from "node:crypto";
import { b64u, signCompactJws } from "./jws.js";
import type { ListKind } from "./trust-domain.js";
import type { Signer } from "./x509.js";

/**
 * The sandbox's trust lists: ETSI TS 119 602 V1.1.1 LoTEs, Annexes D (PID providers), F (Access
 * CAs) and G (WRPRC providers), `docs/sandbox/specification.md` §7.3.
 *
 * The shape is the notified lists' own, field for field, as published at
 * `trustedlist.serviceproviders.eudiw.dev` on 12 November 2026 — a hand-written list missing
 * `TEAddress` was refused by the wallet's parser in September (`scripts/make-test-lote.mjs`), so
 * nothing here is left to a reading of the specification alone. Every value that identifies the
 * publisher is the sandbox's: operator, scheme name, addresses, URLs, signer.
 *
 * The `LoTEType` values are the EU-list values, because the wallet selects lists by them; the reuse
 * is stated in the scheme name. This imitates a list *type*, not a publisher.
 *
 * Signed as compact JAdES B-B: `{alg, typ, x5c, x5t#S256, iat}`, no `sigT` and no `crit`
 * (TS 119 182-1 V1.2.1 §5.1.11, §5.2.1) — the header the notified lists themselves now carry.
 */

interface KindProfile {
  readonly loteType: string;
  readonly statusDetermination: string;
  readonly schemeRules: string;
  readonly serviceType: string;
  readonly subject: string;
}

const ETSI = "http://uri.etsi.org/19602";

export const LOTE_PROFILES: Readonly<Record<ListKind, KindProfile>> = {
  PID: {
    loteType: `${ETSI}/LoTEType/EUPIDProvidersList`,
    statusDetermination: `${ETSI}/PIDProvidersList/StatusDetn/EU`,
    // Annex D spells this one without "List" (TS 119 602 V1.1.1), unlike F and G.
    schemeRules: `${ETSI}/PIDProviders/schemerules/EU`,
    serviceType: `${ETSI}/SvcType/PID`,
    subject: "PID providers",
  },
  WRPAC: {
    loteType: `${ETSI}/LoTEType/EUWRPACProvidersList`,
    statusDetermination: `${ETSI}/WRPACProvidersList/StatusDetn/EU`,
    schemeRules: `${ETSI}/WRPACProvidersList/schemerules/EU`,
    serviceType: `${ETSI}/SvcType/WRPAC`,
    subject: "access certificate authorities (WRPAC providers)",
  },
  WRPRC: {
    loteType: `${ETSI}/LoTEType/EUWRPRCProvidersList`,
    // The typo ("WRPRCrovidersList") is normative as printed in Annex G and C.2.2, and the notified
    // list carries it too.
    statusDetermination: `${ETSI}/WRPRCrovidersList/StatusDetn/EU`,
    schemeRules: `${ETSI}/WRPRCProvidersList/schemerules/EU`,
    serviceType: `${ETSI}/SvcType/WRPRC`,
    subject: "registration certificate providers (WRPRC providers)",
  },
};

export interface LoteAnchor {
  readonly serviceName: string;
  readonly certificate: Buffer;
}

export interface LoteEntity {
  readonly name: string;
  readonly tradeName: string;
  readonly informationUri: string;
  readonly email: string;
  readonly anchors: readonly LoteAnchor[];
}

export interface LoteInput {
  readonly kind: ListKind;
  readonly sequenceNumber: number;
  readonly issuedAt: Date;
  readonly nextUpdate: Date;
  /** Where this list is published: its own location, as `PointersToOtherLoTE` and distribution point. */
  readonly publicationUrl: string;
  readonly informationUrl: string;
  readonly operatorEmail: string;
  readonly entities: readonly LoteEntity[];
  readonly signer: Signer;
  readonly signerCertificate: Buffer;
}

export const SANDBOX_OPERATOR_NAME = "EDTP Sandbox — TEST ONLY";

const iso = (d: Date) => `${d.toISOString().slice(0, 19)}Z`;
const en = (value: string) => [{ lang: "en", value }];
const enUri = (uriValue: string) => [{ lang: "en", uriValue }];
const address = (email: string) => ({
  postal: [
    {
      lang: "en",
      StreetAddress: "Not a postal address: test operator",
      Country: "EU",
      Locality: "TEST",
      StateOrProvince: "TEST",
      PostalCode: "00000",
    },
  ],
  electronic: enUri(`mailto:${email}`),
});

export function buildLote(input: LoteInput): Record<string, unknown> {
  if (!Number.isInteger(input.sequenceNumber) || input.sequenceNumber < 1) {
    throw new Error("LoTESequenceNumber starts at 1 (TS 119 602 §6.3.2)");
  }
  const maxNext = new Date(input.issuedAt);
  maxNext.setUTCMonth(maxNext.getUTCMonth() + 6);
  if (input.nextUpdate > maxNext || input.nextUpdate <= input.issuedAt) {
    throw new Error(
      "NextUpdate must be after the issue time and at most 6 months later (Annexes D, F, G)",
    );
  }
  const profile = LOTE_PROFILES[input.kind];
  const operator = address(input.operatorEmail);
  const signer = input.signerCertificate.toString("base64");
  return {
    LoTE: {
      ListAndSchemeInformation: {
        LoTEVersionIdentifier: 1,
        LoTESequenceNumber: input.sequenceNumber,
        SchemeOperatorName: en(SANDBOX_OPERATOR_NAME),
        ListIssueDateTime: iso(input.issuedAt),
        NextUpdate: iso(input.nextUpdate),
        LoTEType: profile.loteType,
        SchemeOperatorAddress: {
          SchemeOperatorPostalAddress: operator.postal,
          SchemeOperatorElectronicAddress: operator.electronic,
        },
        SchemeName: en(
          `EDTP Sandbox TEST list of ${profile.subject} — NOT a notified list, NOT the EU list; ` +
            "it reuses the EU list type so a test wallet can read it",
        ),
        SchemeInformationURI: enUri(input.informationUrl),
        StatusDeterminationApproach: profile.statusDetermination,
        SchemeTypeCommunityRules: enUri(profile.schemeRules),
        SchemeTerritory: "EU",
        PolicyOrLegalNotice: [{ LoTEPolicy: { lang: "en", uriValue: input.informationUrl } }],
        PointersToOtherLoTE: [
          {
            LoTELocation: input.publicationUrl,
            ServiceDigitalIdentities: [{ X509Certificates: [{ val: signer }] }],
            LoTEQualifiers: [
              {
                LoTEType: profile.loteType,
                SchemeOperatorName: en(SANDBOX_OPERATOR_NAME),
                MimeType: "application/jwt",
                SchemeTypeCommunityRules: enUri(profile.schemeRules),
                SchemeTerritory: "EU",
              },
            ],
          },
        ],
        DistributionPoints: [input.publicationUrl],
      },
      TrustedEntitiesList: input.entities.map((entity) => {
        const a = address(entity.email);
        return {
          TrustedEntityInformation: {
            TEName: en(entity.name),
            TEAddress: { TEPostalAddress: a.postal, TEElectronicAddress: a.electronic },
            TEInformationURI: enUri(entity.informationUri),
            TETradeName: en(entity.tradeName),
          },
          TrustedEntityServices: entity.anchors.flatMap((anchor) =>
            (["Issuance", "Revocation"] as const).map((suffix) => ({
              ServiceInformation: {
                ServiceName: en(
                  suffix === "Issuance"
                    ? anchor.serviceName
                    : `${anchor.serviceName} Revocation`,
                ),
                ServiceDigitalIdentity: {
                  X509Certificates: [{ val: anchor.certificate.toString("base64") }],
                },
                ServiceTypeIdentifier: `${profile.serviceType}/${suffix}`,
                SchemeServiceDefinitionURI: enUri(input.informationUrl),
              },
            })),
          ),
        };
      }),
    },
  };
}

export function signLote(input: LoteInput): string {
  const lote = buildLote(input);
  return signCompactJws(
    {
      typ: "JOSE+JSON",
      x5c: [input.signerCertificate.toString("base64")],
      "x5t#S256": b64u(createHash("sha256").update(input.signerCertificate).digest()),
      iat: Math.floor(input.issuedAt.getTime() / 1000),
    },
    lote,
    input.signer,
  );
}
