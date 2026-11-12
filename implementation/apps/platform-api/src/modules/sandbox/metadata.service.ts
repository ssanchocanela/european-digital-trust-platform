import { X509Certificate } from "node:crypto";
import type { EudiIssuerProvisioningPort } from "@edtp/eudi-issuer-port";
import type { SandboxCertificateRepository, SandboxIssuerRepository } from "@edtp/persistence";
import { signCompactJws } from "@edtp/sandbox-pki";
import { type Clock, PlatformError } from "@edtp/shared";
import type { SandboxTrustDomain } from "./trust-domain.runtime.js";

/**
 * Signed Credential Issuer metadata for the sandbox's hosted issuers — ADR 0016, option 2: signed
 * in front of the engine, which signs nothing.
 *
 * The format is the one the pinned wallet's OpenID4VCI library (0.13.1) asks for and verifies:
 * - the wallet requests the well-known document with `Accept: application/jwt`;
 * - it expects a JWT whose `typ` is `openidvci-issuer-metadata+jwt`;
 * - the claims are the metadata itself, with `sub` equal to the Credential Issuer identifier and
 *   `iat` present;
 * - the chain is in `x5c`, which the wallet validates in its access-certificate trust context.
 *
 * ETSI TS 119 472-3 V1.1.1 asks the same of the content:
 * - the signing certificate is the provider's access certificate (`ISS-MDATA-4.2.1-02`);
 * - it travels in `x5c` (`ISS-MDATA-ACC_CERT-4.2.2-01/-02`);
 * - `issuer_info` sits at the top level of the signed payload (`ISS-MDATA-REG_CERT-4.2.3-02`).
 *
 * The engine already puts `issuer_info` at the top level of its JSON, so signing the document as
 * served places it correctly.
 *
 * Only sandbox issuers, found by their engine tenant. Every field the engine serves passes through
 * unchanged: the sandbox adds a signature, it does not edit what the issuer says.
 */
export const SIGNED_METADATA_TYP = "openidvci-issuer-metadata+jwt";
const SANDBOX_ISSUER_REF = /^sbx-iss-[a-z0-9]{12}$/;

export interface IssuerMetadata {
  readonly json: Readonly<Record<string, unknown>>;
  /** Absent for an issuer configured before S5b, until it is reconfigured. */
  readonly jwt?: string;
}

export class SandboxMetadataService {
  constructor(
    private readonly issuers: SandboxIssuerRepository,
    private readonly certificates: SandboxCertificateRepository,
    private readonly issuerProvisioning: EudiIssuerProvisioningPort,
    private readonly domain: SandboxTrustDomain,
    private readonly clock: Clock,
  ) {}

  async metadata(engineTenantRef: string): Promise<IssuerMetadata> {
    if (!SANDBOX_ISSUER_REF.test(engineTenantRef))
      throw PlatformError.notFound("Credential Issuer");
    const issuer = await this.issuers.issuerByEngineTenant(engineTenantRef);
    if (!issuer) throw PlatformError.notFound("Credential Issuer");
    if (!this.issuerProvisioning.fetchCredentialIssuerMetadata) {
      throw PlatformError.conflict(
        "sandbox_metadata_unsupported",
        "The engine adapter cannot read issuer metadata.",
      );
    }
    const json = await this.issuerProvisioning.fetchCredentialIssuerMetadata(engineTenantRef);
    if (!issuer.accessKeyName || !issuer.accessCertificateId) return { json };

    const access = await this.certificates.certificate(
      issuer.tenantId,
      issuer.accessCertificateId,
    );
    if (!access?.body) return { json };
    const leaf = new X509Certificate(access.body).raw;
    const chain = [leaf, this.domain.certificate(access.issuerKey)];
    const credentialIssuer = String(json.credential_issuer ?? "");
    if (!credentialIssuer)
      throw PlatformError.engine(
        "engine_metadata_incomplete",
        "The issuer metadata names no credential_issuer.",
      );
    const iat = Math.floor(this.clock.now().getTime() / 1000);
    const jwt = signCompactJws(
      { typ: SIGNED_METADATA_TYP, x5c: chain.map((c) => c.toString("base64")) },
      { ...json, iss: credentialIssuer, sub: credentialIssuer, iat },
      await this.domain.signer(issuer.accessKeyName),
    );
    return { json, jwt };
  }
}
