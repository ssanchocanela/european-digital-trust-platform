import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTrustDomain, FileKeyStore } from "@edtp/sandbox-pki";
import { asId, newCorrelationId, PlatformError, type TenantId } from "@edtp/shared";
import { SandboxCertificateService } from "../../apps/platform-api/src/modules/sandbox/certificates.service.js";
import { SandboxPublicationService } from "../../apps/platform-api/src/modules/sandbox/publication.service.js";
import { SandboxRegister } from "../../apps/platform-api/src/modules/sandbox/register.js";
import { SandboxService } from "../../apps/platform-api/src/modules/sandbox/sandbox.service.js";
import { SandboxTrustDomain } from "../../apps/platform-api/src/modules/sandbox/trust-domain.runtime.js";
import { sandboxUrls } from "../../apps/platform-api/src/modules/sandbox/urls.js";
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

export async function wireSandbox(
  harness: Harness,
  options: { pidSignInAnchors?: { name: string; certificate: Buffer }[] } = {},
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

  async function signUp(disclosed: Record<string, unknown>, name: string, country = "ES") {
    const attempt = await sandbox.startSignIn({
      purpose: "sign_up",
      interactionType: "SAME_DEVICE",
      correlationId: newCorrelationId(),
    });
    harness.verifier.settleLastVerified(disclosed);
    await sandbox.completeSignIn(attempt.attemptId, attempt.bindingToken, newCorrelationId());
    const done = await sandbox.completeProfile({
      attemptId: attempt.attemptId,
      bindingToken: attempt.bindingToken,
      displayName: name,
      organisation: {
        legalName: `${name} S.A.`,
        tradeName: name,
        country,
        isPublicSectorBody: false,
      },
    });
    const context = await sandbox.authenticate(done.sessionToken);
    return { context, organisationId: done.organisation?.tenantId as TenantId };
  }

  return {
    sandbox,
    domain,
    urls,
    publications,
    certificates,
    register,
    signUp,
    operatorTenantId: asId<"TenantId">(operator.tenantId),
  };
}
