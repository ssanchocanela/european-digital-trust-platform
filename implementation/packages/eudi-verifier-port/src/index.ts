import type {
  DisclosedClaims,
  InteractionType,
  TerminalState,
  VerificationPlan,
} from "@edtp/domain";
import type { EngineSessionRef } from "@edtp/shared";

/**
 * The verifier port.
 *
 * Platform types only. No EUDIPLO type, identifier, configuration object or error
 * crosses this boundary — ADR 0002 Decision 2. An implementation of this interface is
 * the only code permitted to know that a protocol engine exists.
 */

export interface CreatePresentationRequestInput {
  readonly plan: VerificationPlan;
  readonly interactionType: InteractionType;
  /**
   * Where the wallet returns the user after a same-device flow. Resolved from the
   * Relying Party Service allow-list before it reaches the port, never taken from an
   * arbitrary request field.
   */
  readonly returnUrl?: string;
  /** Sizes the engine session window. Must not exceed the transaction lifetime. */
  readonly sessionTtlSeconds: number;
}

export interface PresentationInteraction {
  readonly type: InteractionType;
  /**
   * The wallet invocation URI, passed through as an **opaque value**. The platform does
   * not parse, rewrite or validate its contents; doing so would couple the business
   * layer to the protocol.
   */
  readonly uri: string;
}

/**
 * Everything needed to address an engine session later.
 *
 * The engine scopes every call to the tenant of the presenting token, so a session can
 * only be read with the credentials of the tenant that created it. Carrying the tenant
 * reference alongside the session reference keeps the adapter stateless: the platform
 * already stores both on the transaction, so nothing has to be remembered in process
 * memory and a restart loses nothing.
 */
export interface EngineSessionHandle {
  readonly ref: EngineSessionRef;
  readonly engineTenantRef: string;
}

export interface CreatePresentationRequestOutput {
  readonly session: EngineSessionHandle;
  readonly interaction: PresentationInteraction;
  /**
   * True when the request was sent without a registration certificate.
   *
   * `EW-DM-44-023` (`RPRC_19`) requires a Relying Party Instance to include a single
   * applicable registration certificate in each presentation request, by value. V0
   * cannot obtain one (blocker B3), so the adapter reports the omission and the
   * platform records it. It is never fabricated and never silently ignored.
   */
  readonly sentWithoutRegistrationCertificate: boolean;
}

/** Where the engine is in the flow, in platform terms. */
export const ENGINE_PROGRESS = [
  "AWAITING_WALLET",
  "PRESENTATION_RECEIVED",
  "VERIFYING",
  "SETTLED",
] as const;
export type EngineProgress = (typeof ENGINE_PROGRESS)[number];

export interface PresentationStatus {
  readonly progress: EngineProgress;
  /**
   * Present when `progress` is `SETTLED`. The platform outcome the adapter derived
   * from the engine's failure taxonomy — ADR 0002 Decision 4. The adapter branches on
   * the engine's machine-readable failure code, never on its coarse session status.
   */
  readonly outcome?: TerminalState;
  /** Stable machine-readable failure code, retained for diagnosis. */
  readonly failureCode?: string;
  /** Short, safe message. Carries no certificate subjects, thumbprints or list URLs. */
  readonly failureMessage?: string;
  /**
   * True when the failure is a verifier-side condition — a trust list that could not
   * be loaded or validated — rather than a defect in the presented credential. The
   * platform must not report this to the customer as a failed credential.
   */
  readonly verifierSideFailure?: boolean;
}

export interface PresentationResultPayload extends PresentationStatus {
  /**
   * Disclosed claims, present only on a successful verification.
   *
   * **This is content.** The caller must apply the result policy in the same call
   * stack and discard this value immediately afterwards. It is never persisted, never
   * logged and never returned to a customer — ARF `AS-RP-01-002` (`OIA_16`), ADR 0004.
   */
  readonly disclosedClaims?: DisclosedClaims;
}

export interface EudiVerifierPort {
  createPresentationRequest(
    input: CreatePresentationRequestInput,
  ): Promise<CreatePresentationRequestOutput>;

  getPresentationStatus(session: EngineSessionHandle): Promise<PresentationStatus>;

  /**
   * Fetches the settled result including disclosed claims.
   *
   * Separate from `getPresentationStatus` so that polling for progress never pulls
   * content into the process, and content is fetched exactly once, at the moment the
   * result policy runs.
   */
  processPresentationResult(session: EngineSessionHandle): Promise<PresentationResultPayload>;

  cancelPresentation(session: EngineSessionHandle): Promise<void>;
}

/** Configuration the platform applies to an engine tenant when provisioning it. */
export interface EngineRetentionSettings {
  readonly sessionTtlSeconds: number;
  readonly cleanupMode: "FULL" | "ANONYMIZE";
}

/**
 * Input for importing an access certificate and its key into the engine key store.
 *
 * The key arrives as a JWK and the chain as PEM, leaf first, because that is what the
 * engine's import endpoint accepts — it does not take a PKCS#12 blob. A P12 from a
 * registrar must be converted first; `scripts/import-access-certificate.sh` does that
 * with `openssl`. See `docs/interop-findings.md` A8.
 *
 * The private key passes through the process in memory only. The platform stores the
 * opaque key-binding reference the engine returns and never the key itself, so there is
 * no platform-side key material to protect, log or leak.
 */
export interface ImportAccessCertificateInput {
  readonly engineTenantRef: string;
  readonly name: string;
  readonly privateKeyJwk: Readonly<Record<string, unknown>>;
  /** Certificate chain, leaf first. PEM or base64 DER. */
  readonly certificateChain: readonly string[];
}

/**
 * Provisioning operations, kept separate from the request/response path because they
 * run once per Relying Party Instance rather than per transaction.
 */
export interface EudiVerifierProvisioningPort {
  /** Applies the mandatory retention settings and asserts the result — ADR 0004. */
  applyRetentionSettings(
    engineTenantRef: string,
    settings: EngineRetentionSettings,
  ): Promise<void>;

  /**
   * Imports an access certificate and its key into the engine key store, returning an
   * opaque key-binding reference. The platform never holds the private key.
   */
  importAccessCertificate(input: ImportAccessCertificateInput): Promise<{
    readonly keyBindingRef: string;
  }>;

  healthy(): Promise<boolean>;
}
