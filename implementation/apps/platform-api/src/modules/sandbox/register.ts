import type { RegisteredCredential } from "@edtp/domain";
import type { SandboxCertificateRepository } from "@edtp/persistence";
import {
  credentialMeta,
  ENTITLEMENT_PID_PROVIDER,
  ENTITLEMENT_SERVICE_PROVIDER,
  signCompactJws,
} from "@edtp/sandbox-pki";
import type { Clock } from "@edtp/shared";
import { PID_TYPE_SD_JWT } from "./certificates.service.js";
import type { SandboxTrustDomain } from "./trust-domain.runtime.js";
import type { SandboxUrls } from "./urls.js";

/**
 * The sandbox register's read API — TS5 1.5 §3 and Annex A.2 (`ts5-openapi31-registrar-api.yml`):
 * `GET /wrp`, `/wrp/{identifier}`, `/wrp/{identifier}/services/{serviceIdentifier}` and
 * `/wrp/check-intended-use`, each answered as a JWS over `{iss, iat, data}` (`SignedWRP`,
 * `SignedWRPArray`, `SignedIntendedUseCheckResult`). `AS-MS-27-005` (`Reg_03`) and `AS-MS-27-008`
 * (`Reg_06`) ask a registrar for exactly this; the sandbox offers it so a participant can test its own
 * lookups. **Not claimed**: harmonised registration, or conformance to TS5.
 *
 * Signed by the sandbox registrar, with its chain in `x5c`. TS5 shows an `x-jku-url` response header
 * for the key; the sandbox gives `x5c` instead, because the registrar's key is a certificate the WRPRC
 * providers' list already anchors.
 *
 * Only what the sandbox register holds is published: declared organisation data marked as such,
 * services, entitlements and intended uses. No person, and no declared EUID as an identifier
 * (ADR 0015 Decision 6).
 */
export class SandboxRegister {
  constructor(
    private readonly repository: SandboxCertificateRepository,
    private readonly domain: SandboxTrustDomain,
    private readonly urls: SandboxUrls,
    private readonly clock: Clock,
  ) {}

  private async entries() {
    const register = await this.repository.register();
    return register.map((org) => ({
      identifier: [{ identifier: org.localIdentifier, type: "urn:edtp:sandbox:identifier" }],
      country: org.country,
      legalPerson: { legalName: org.legalName },
      tradeName: org.services[0]?.serviceTradeName ?? org.legalName,
      isPSB: org.isPublicSectorBody,
      registryURI: this.urls.registryEntry(org.localIdentifier),
      verified: false,
      services: org.services.map((s) => ({
        serviceTradeName: s.serviceTradeName,
        serviceIdentifier: s.serviceIdentifier,
        supportURI: s.supportUri,
        srvDescription: s.description.map((d) => ({ lang: d.lang, content: d.value })),
        entitlements: [
          s.role === "pid_provider" ? ENTITLEMENT_PID_PROVIDER : ENTITLEMENT_SERVICE_PROVIDER,
        ],
        providesAttestations:
          s.role === "pid_provider" ? [{ format: "dc+sd-jwt", type: PID_TYPE_SD_JWT }] : [],
        intendedUses: s.intendedUses.map((u) => ({
          intendedUseIdentifier: u.intendedUseIdentifier,
          purpose: (u.purpose as { lang: string; value: string }[]).map((p) => ({
            lang: p.lang,
            content: p.value,
          })),
          privacyPolicy: (u.privacyPolicyUris as { lang: string; value: string }[]).map(
            (p) => ({
              type: "privacy-policy",
              policyURI: p.value,
            }),
          ),
          createdAt: u.validFrom.toISOString(),
          ...(u.revokedAt ? { revokedAt: u.revokedAt.toISOString() } : {}),
          credentials: (u.registeredCredentials as RegisteredCredential[]).map((c) => ({
            format: c.format,
            meta: credentialMeta(
              c.format,
              c.format === "dc+sd-jwt" ? (c.vctValues ?? []) : [c.doctype ?? ""],
            ),
            claims: c.claims.map((path) => ({ path })),
          })),
        })),
      })),
    }));
  }

  private async sign(data: unknown, extra: Record<string, unknown> = {}): Promise<string> {
    const iat = Math.floor(this.clock.now().getTime() / 1000);
    return signCompactJws(
      {
        typ: "JWT",
        x5c: this.domain.chainOf("registrar-signing").map((c) => c.toString("base64")),
        iat,
      },
      { iss: this.urls.register, iat, data, ...extra },
      await this.domain.signer("registrar-signing"),
    );
  }

  async list(filters: {
    identifier?: string;
    entitlement?: string;
    serviceIdentifier?: string;
  }): Promise<string> {
    const all = (await this.entries()).filter(
      (e) =>
        (!filters.identifier ||
          e.identifier.some((i) => i.identifier === filters.identifier)) &&
        (!filters.entitlement ||
          e.services.some((s) =>
            s.entitlements.some(
              (x) => x === filters.entitlement || x.endsWith(`/${filters.entitlement}`),
            ),
          )) &&
        (!filters.serviceIdentifier ||
          e.services.some((s) => s.serviceIdentifier === filters.serviceIdentifier)),
    );
    return this.sign(all, { pagination: { has_next_page: false } });
  }

  async one(identifier: string): Promise<string | undefined> {
    const entry = (await this.entries()).find((e) =>
      e.identifier.some((i) => i.identifier === identifier),
    );
    return entry ? this.sign(entry) : undefined;
  }

  async service(identifier: string, serviceIdentifier: string): Promise<string | undefined> {
    const entry = (await this.entries()).find((e) =>
      e.identifier.some((i) => i.identifier === identifier),
    );
    const service = entry?.services.find((s) => s.serviceIdentifier === serviceIdentifier);
    return entry && service ? this.sign({ ...entry, services: [service] }) : undefined;
  }

  async checkIntendedUse(q: {
    identifier?: string;
    serviceIdentifier?: string;
    intendedUseIdentifier?: string;
  }) {
    const found = (await this.entries()).some(
      (e) =>
        (!q.identifier || e.identifier.some((i) => i.identifier === q.identifier)) &&
        e.services.some(
          (s) =>
            (!q.serviceIdentifier || s.serviceIdentifier === q.serviceIdentifier) &&
            s.intendedUses.some(
              (u) =>
                !q.intendedUseIdentifier || u.intendedUseIdentifier === q.intendedUseIdentifier,
            ),
        ),
    );
    return this.sign({ result: found });
  }
}
