import type { CredentialStatus } from "@edtp/domain";
import type {
  CreateCredentialOfferInput,
  CreateCredentialOfferOutput,
  CredentialOfferHandle,
  EudiIssuerPort,
  EudiIssuerProvisioningPort,
  IssuanceProvisioningInput,
  IssuanceStatus,
  ProviderAuthenticationEvidence,
} from "@edtp/eudi-issuer-port";
import { asId } from "@edtp/shared";

/**
 * A fake issuer port, as `FakeVerifier` is for presentations: it records what the adapter would have
 * been asked and lets a test script the engine's answers. Claims passed to an offer are counted, never
 * kept, so a test cannot come to depend on content the real adapter does not hold either.
 */
export class FakeIssuer implements EudiIssuerPort, EudiIssuerProvisioningPort {
  readonly signingImports: { engineTenantRef: string; chainLength: number }[] = [];
  readonly provisioned: {
    engineTenantRef: string;
    signingKeyBindingRef: string;
    registrationCertificate: boolean;
  }[] = [];
  readonly offers: { engineTenantRef: string; claimCount: number }[] = [];
  readonly statusUpdates: { ref: string; status: CredentialStatus }[] = [];
  private counter = 0;
  private outcomes = new Map<string, IssuanceStatus>();

  async createCredentialOffer(
    input: CreateCredentialOfferInput,
  ): Promise<CreateCredentialOfferOutput> {
    this.counter += 1;
    const ref = `issuance-session-${this.counter}`;
    const engineTenantRef = input.plan.providerContext.engineTenantRef;
    this.offers.push({ engineTenantRef, claimCount: Object.keys(input.claims).length });
    this.outcomes.set(ref, { progress: "AWAITING_WALLET" });
    return {
      session: { ref: asId<"EngineSessionRef">(ref), engineTenantRef },
      uri: `openid-credential-offer://?credential_offer_uri=https%3A%2F%2Fengine.test%2F${ref}`,
      sentWithoutRegistrationCertificate:
        input.plan.providerContext.registrationCertificateJwt === undefined,
    };
  }

  settleLastIssued(): void {
    this.outcomes.set(`issuance-session-${this.counter}`, {
      progress: "SETTLED",
      outcome: "ISSUED",
      statusListUri: "https://engine.test/status/1",
      statusListIndex: this.counter,
    });
  }

  async getIssuanceStatus(session: CredentialOfferHandle): Promise<IssuanceStatus> {
    return this.outcomes.get(session.ref) ?? { progress: "AWAITING_WALLET" };
  }

  async updateCredentialStatus(input: {
    session: CredentialOfferHandle;
    status: CredentialStatus;
  }): Promise<void> {
    this.statusUpdates.push({ ref: input.session.ref, status: input.status });
  }

  async cancelIssuance(): Promise<void> {}
  async resolveAuthorizationRequest(): Promise<string | undefined> {
    return undefined;
  }
  async findWalletAuthorizationRequest() {
    return undefined;
  }

  async provisionCredentialConfiguration(input: IssuanceProvisioningInput): Promise<void> {
    this.provisioned.push({
      engineTenantRef: input.engineTenantRef,
      signingKeyBindingRef: input.plan.providerContext.signingKeyBindingRef,
      registrationCertificate:
        input.plan.providerContext.registrationCertificateJwt !== undefined,
    });
  }

  async withdrawCredentialConfigurations(): Promise<void> {}

  async importSigningCertificate(input: {
    engineTenantRef: string;
    certificateChain: readonly string[];
  }): Promise<{ readonly keyBindingRef: string }> {
    this.signingImports.push({
      engineTenantRef: input.engineTenantRef,
      chainLength: input.certificateChain.length,
    });
    return { keyBindingRef: `signing-key-${this.signingImports.length}` };
  }

  async importAccessCertificate(): Promise<{ readonly keyBindingRef: string }> {
    return { keyBindingRef: "issuer-access-key" };
  }

  async fetchProviderAuthenticationEvidence(
    engineTenantRef: string,
  ): Promise<ProviderAuthenticationEvidence> {
    return {
      credentialIssuer: `https://engine.test/issuers/${engineTenantRef}`,
      registrationCertificatePresent: false,
      metadataSigned: false,
      accessCertificateInSignedMetadata: false,
      registrationCertificateInSignedPayload: false,
      credentialConfigurationIds: [],
    };
  }

  async fetchCredentialIssuerMetadata(
    engineTenantRef: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    return {
      credential_issuer: `https://engine.test/issuers/${engineTenantRef}`,
      credential_endpoint: `https://engine.test/issuers/${engineTenantRef}/vci/credential`,
      credential_configurations_supported: {
        pid: { format: "dc+sd-jwt", vct: "urn:eudi:pid:1" },
      },
      issuer_info: [{ format: "registration_cert", data: "eyJ.registration.cert" }],
    };
  }

  async healthy(): Promise<boolean> {
    return true;
  }

  reset(): void {
    this.signingImports.length = 0;
    this.provisioned.length = 0;
    this.offers.length = 0;
    this.statusUpdates.length = 0;
    this.outcomes.clear();
    this.counter = 0;
  }
}
