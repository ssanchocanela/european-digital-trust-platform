import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineCredentialRepository } from "@edtp/persistence";
import { createTrustDomain, FileKeyStore } from "@edtp/sandbox-pki";
import { asId, PlatformError, type TenantId } from "@edtp/shared";
import { EngineTenantService } from "../../apps/platform-api/src/modules/engine-tenants/engine-tenant.service.js";
import type {
  AccessIdentity,
  AccessIdentityVerifier,
} from "../../apps/platform-api/src/modules/sandbox/access-identity.js";
import { SandboxCertificateService } from "../../apps/platform-api/src/modules/sandbox/certificates.service.js";
import { SandboxIssuerService } from "../../apps/platform-api/src/modules/sandbox/issuer.service.js";
import { SandboxMetadataService } from "../../apps/platform-api/src/modules/sandbox/metadata.service.js";
import { SandboxPublicationService } from "../../apps/platform-api/src/modules/sandbox/publication.service.js";
import { SandboxRegister } from "../../apps/platform-api/src/modules/sandbox/register.js";
import { SandboxService } from "../../apps/platform-api/src/modules/sandbox/sandbox.service.js";
import { SandboxTrustDomain } from "../../apps/platform-api/src/modules/sandbox/trust-domain.runtime.js";
import { sandboxUrls } from "../../apps/platform-api/src/modules/sandbox/urls.js";
import { SandboxVerifierService } from "../../apps/platform-api/src/modules/sandbox/verifier.service.js";
import type { Harness } from "./harness.js";
import { seedTenant } from "./seed.js";

/** A sandbox wired on a harness: sign-in (S2) and, with a trust domain, the certificate service (S3). */
export const SIGN_IN_PATHS = [
  ["given_name"],
  ["family_name"],
  ["birthdate"],
  ["issuing_authority"],
  ["issuing_country"],
];
export const PUBLIC_BASE = "https://sandbox.test/sandbox/public";

export const person = (given: string, birthdate = "1990-04-01") => ({
  given_name: given,
  family_name: "Ejemplo",
  birthdate,
  issuing_authority: "Test PID Provider",
  issuing_country: "ES",
});

export async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof PlatformError ? error.code : String(error);
  }
  return "no error";
}

export const VERIFIER_DNS = "engine.sandbox.test";

/**
 * A stand-in for Cloudflare Access in tests that drive the service directly: the "assertion" is the
 * address itself. The real verifier, with signatures, is tested on its own (sandbox-access-identity).
 */
export const testAccess: AccessIdentityVerifier = {
  async verify(assertion: string | undefined): Promise<AccessIdentity> {
    if (!assertion?.includes("@")) throw PlatformError.unauthenticated();
    return { email: assertion.toLowerCase() };
  },
};

export const identity = (email: string): AccessIdentity => ({ email: email.toLowerCase() });

export async function wireSandbox(
  harness: Harness,
  options: {
    pidSignInAnchors?: { name: string; certificate: Buffer }[];
    withoutEngineTenants?: boolean;
    /** The Wallet Provider anchors a hosted issuer loads; and the list id that makes it require them. */
    walletProviderAnchors?: { name: string; certificate: Buffer }[];
    walletProviderTrustListId?: string;
  } = {},
) {
  const operator = await seedTenant(harness, {
    name: "EDTP Sandbox operator",
    registeredClaims: SIGN_IN_PATHS,
    publishPolicy: false,
  });
  await harness.deps.services.policies.createVersion({
    tenantId: operator.tenantId,
    policyId: operator.policyId,
    purpose: [{ lang: "en", value: "Sign in to the sandbox" }],
    credentialRequirements: [
      { credentialType: "urn:eudi:pid:1", acceptedFormats: ["dc+sd-jwt"] },
    ],
    requestedClaims: SIGN_IN_PATHS.map((path) => ({ path })),
    resultPolicy: {
      kind: "DERIVED_CLAIMS",
      derivations: [
        { name: "PseudonymousSubject", sourcePaths: SIGN_IN_PATHS, outputClaim: "subject" },
      ],
    },
    trustPolicy: {
      anchorSources: [
        {
          kind: "ETSI_TS_119_602_LOTE",
          domain: "PID_PROVIDER",
          ref: "https://reference.test/lote/PIDProviders.jwt",
        },
      ],
      statusCheckMode: "STRICT",
    },
    publish: true,
  });
  const sandbox = new SandboxService(
    {
      operatorTenantId: operator.tenantId,
      signInPolicyId: operator.policyId,
      participantTrustSources: [`${PUBLIC_BASE}/lote/PIDProviders.jwt`],
      portalPublicUrl: "https://portal.sandbox.test",
    },
    harness.deps.repositories.sandbox,
    harness.deps.repositories.policies,
    harness.deps.repositories.apiKeys,
    harness.deps.services.presentations,
    harness.deps.hostedFormReturns,
    harness.deps.services.audit,
    harness.clock,
    harness.deps.logger,
    testAccess,
  );

  const store = new FileKeyStore(mkdtempSync(join(tmpdir(), "sbx-it-")), Buffer.alloc(32, 8));
  const issued = await createTrustDomain(
    store,
    new Date(harness.clock.now().getTime() - 86_400_000),
  );
  const domain = SandboxTrustDomain.from(
    store,
    new Map(issued.map((i) => [i.member.name, i.certificate])),
    options.pidSignInAnchors ?? [],
    options.walletProviderAnchors ?? [],
  );
  const urls = sandboxUrls(PUBLIC_BASE);
  const publications = new SandboxPublicationService(
    harness.deps.repositories.sandboxCertificates,
    domain,
    urls,
    harness.clock,
    harness.deps.logger,
  );
  const certificates = new SandboxCertificateService(
    sandbox,
    harness.deps.repositories.sandbox,
    harness.deps.repositories.sandboxCertificates,
    harness.deps.services.registration,
    domain,
    publications,
    urls,
    harness.deps.services.audit,
    harness.clock,
  );
  const register = new SandboxRegister(
    harness.deps.repositories.sandboxCertificates,
    domain,
    urls,
    harness.clock,
  );

  let people = 0;
  /**
   * A new person, entered by their Access identity, who creates an organisation (ADR 0018). The first
   * argument is kept for the callers written when sign-up was a PID presentation; it is not used.
   */
  async function signUp(_unused: unknown, name: string, country = "ES") {
    people += 1;
    const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, ".")}.${people}@example.test`;
    const done = await sandbox.createProfile(identity(email), {
      displayName: name,
      organisation: {
        legalName: `${name} S.A.`,
        tradeName: name,
        country,
        isPublicSectorBody: false,
      },
    });
    const context = await sandbox.authenticate(done.sessionToken);
    return {
      context,
      email,
      sessionToken: done.sessionToken,
      organisationId: done.organisation?.tenantId as TenantId,
    };
  }

  const createdEngineTenants: string[] = [];
  const engineTenants = options.withoutEngineTenants
    ? undefined
    : new EngineTenantService(
        {
          createEngineTenant: async ({ engineTenantRef }) => {
            createdEngineTenants.push(engineTenantRef);
            return { clientId: `client-${engineTenantRef}`, clientSecret: "secret" };
          },
        },
        new EngineCredentialRepository(harness.handle.db, Buffer.alloc(32, 6)),
        harness.verifier,
        harness.clock,
        harness.deps.logger,
        120,
      );
  const verifier = new SandboxVerifierService(
    {
      dnsName: VERIFIER_DNS,
      portalPublicUrl: "https://portal.sandbox.test",
      pidListRef: urls.lote("PID"),
      pidTrustListId: "sbx-pid-providers",
    },
    sandbox,
    certificates,
    harness.deps.repositories.sandboxCertificates,
    harness.deps.repositories.sandboxVerifiers,
    harness.deps.repositories.registration,
    harness.deps.services.registration,
    harness.deps.services.policies,
    harness.deps.services.presentations,
    harness.verifier,
    engineTenants,
    domain,
    harness.deps.hostedFormReturns,
    harness.deps.services.audit,
    harness.clock,
  );

  const issuer = harness.issuer
    ? new SandboxIssuerService(
        {
          ...(options.walletProviderTrustListId
            ? { walletProviderTrustListId: options.walletProviderTrustListId }
            : {}),
          metadataDnsName: VERIFIER_DNS,
        },
        sandbox,
        harness.deps.repositories.sandbox,
        certificates,
        harness.deps.repositories.sandboxCertificates,
        harness.deps.repositories.sandboxIssuers,
        harness.deps.repositories.issuance,
        harness.deps.services.issuances,
        harness.issuer,
        harness.verifier,
        engineTenants,
        domain,
        harness.deps.services.audit,
        harness.clock,
      )
    : undefined;

  const metadata = harness.issuer
    ? new SandboxMetadataService(
        harness.deps.repositories.sandboxIssuers,
        harness.deps.repositories.sandboxCertificates,
        harness.issuer,
        domain,
        harness.clock,
      )
    : undefined;

  return {
    sandbox,
    domain,
    urls,
    publications,
    certificates,
    register,
    verifier,
    issuer,
    metadata,
    createdEngineTenants,
    signUp,
    operatorTenantId: asId<"TenantId">(operator.tenantId),
  };
}
