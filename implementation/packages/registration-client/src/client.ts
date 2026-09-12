import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RegistrationEntity } from "./entity.js";
import {
  openStore,
  readHashPid,
  readState,
  recordIds,
  type SessionState,
  type SessionStore,
  storeHashPid,
} from "./state.js";

/**
 * A client for the EUDIW reference RP Registration Service.
 *
 * Every route and payload shape here is read from the service's own OpenAPI document at
 * `/apispec_1.json` (title "My API", version 1.0.0, 51 routes) on 12 September 2026 — not from its
 * `/guide` page, whose narrative examples omit fields the document declares as required, and not
 * from the ARF's vocabulary, which is where an earlier draft of the session plan got route names
 * that turned out not to exist. Recorded as `docs/interop-findings.md` C9.
 *
 * The service is explicitly non-production. Everything it issues is `TEST` trust material, per
 * CLAUDE.md §7.
 */

export const DEFAULT_BASE_URL = "https://registry.serviceproviders.eudiw.dev";

export interface ClientOptions {
  readonly baseUrl?: string;
  readonly store?: SessionStore;
  /** Injected so the chain can be tested without a network. */
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

interface ResolvedOptions {
  readonly baseUrl: string;
  readonly store: SessionStore;
  readonly fetchImpl: typeof globalThis.fetch;
  readonly timeoutMs: number;
}

const resolve = (options: ClientOptions = {}): ResolvedOptions => ({
  baseUrl: options.baseUrl ?? process.env["REGISTRY_BASE_URL"] ?? DEFAULT_BASE_URL,
  store: options.store ?? openStore(),
  fetchImpl: options.fetchImpl ?? globalThis.fetch,
  timeoutMs: options.timeoutMs ?? 60_000,
});

/**
 * A failed call, carrying the service's own response body.
 *
 * The body is the only useful diagnostic — the service names the offending field in it — so it is
 * preserved rather than collapsed into a status code. The **request** body is never attached: it
 * carries `hash_pid`.
 */
export class RegistrationError extends Error {
  constructor(
    readonly route: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${route} failed with HTTP ${status}: ${body.slice(0, 500)}`);
    this.name = "RegistrationError";
  }
}

const request = async (
  options: ResolvedOptions,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown> => {
  const response = await options.fetchImpl(`${options.baseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs),
  });

  const text = await response.text();
  if (!response.ok) {
    // The path is reported without its query string: `presentation_id` is a session identifier.
    throw new RegistrationError(`${method} ${path.split("?")[0]}`, response.status, text);
  }
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Some responses are a bare string rather than JSON. Returning the text lets the caller
    // decide, which is what `completeLogin` needs.
    return text;
  }
};

// --- the login ---------------------------------------------------------------------------
// There are no accounts: the service authenticates by an OID4VP presentation of a PID, and the
// resulting hash_pid is the credential every later call carries.

export interface LoginChallenge {
  /** The value to render as a QR. The phone talks to the EUDI verifier backend, never to us. */
  readonly qrValue: string;
  readonly presentationId: string;
}

export const beginLogin = async (options: ClientOptions = {}): Promise<LoginChallenge> => {
  const resolved = resolve(options);
  const payload = (await request(resolved, "GET", "/authentication")) as {
    QR_code_url?: string;
    presentation_id?: string;
  };
  const qrValue = payload?.QR_code_url;
  const presentationId = payload?.presentation_id;
  if (!qrValue || !presentationId) {
    throw new Error("the service returned no QR value or presentation id");
  }
  return { qrValue, presentationId };
};

/**
 * Whether the holder has completed the presentation yet.
 *
 * The service answers this with an error status until the presentation lands, so a rejection is
 * "not yet" rather than a failure — which is why this returns a boolean rather than throwing.
 */
export const pollLogin = async (
  presentationId: string,
  options: ClientOptions = {},
): Promise<boolean> => {
  const resolved = resolve(options);
  try {
    await request(
      resolved,
      "GET",
      `/pid_authorization?presentation_id=${encodeURIComponent(presentationId)}`,
    );
    return true;
  } catch (error) {
    if (error instanceof RegistrationError) return false;
    throw error;
  }
};

/**
 * Exchanges a completed presentation for `hash_pid` and stores it, mode 600.
 *
 * Returns nothing. The value is deliberately not handed back to the caller: every consumer needs
 * it only inside a request body, which this module builds, and a return value is one more place it
 * could reach a log or a screen. Use `hashPidFingerprint` to display or compare it.
 */
export const completeLogin = async (
  presentationId: string,
  options: ClientOptions = {},
): Promise<void> => {
  const resolved = resolve(options);
  const payload = await request(
    resolved,
    "POST",
    `/getpidoid4vp?presentation_id=${encodeURIComponent(presentationId)}`,
  );

  // Documented as a bare string; some builds wrap it. Accept both rather than depending on which.
  const value =
    typeof payload === "string"
      ? payload.trim().replace(/^"|"$/g, "")
      : ((payload as { hash_pid?: string; data?: string })?.hash_pid ??
        (payload as { data?: string })?.data);

  if (!value || value.length === 0) throw new Error("the service returned no hash_pid");
  storeHashPid(resolved.store, value);
};

// --- the chain ---------------------------------------------------------------------------

export interface StepContext {
  readonly entity: RegistrationEntity;
  readonly state: SessionState;
}

export interface StepDescriptor {
  readonly key: string;
  readonly label: string;
  readonly route: string;
  /** The property the request body wraps the payload in; they are all different. */
  readonly envelope: string;
  readonly build: (context: StepContext) => unknown;
}

const ids = (state: SessionState, key: string): readonly number[] => state[key] ?? [];
const firstId = (state: SessionState, key: string): number | undefined => ids(state, key)[0];

/**
 * The fourteen calls, in the only order that works: each consumes identifiers minted by an earlier
 * one, and the service rejects a reference it cannot resolve.
 *
 * Declared as data rather than as a function body so that both front ends iterate the same list —
 * the console renders it as a checklist and the CLI walks it — and so a step cannot exist in one
 * and not the other.
 */
export const STEPS: readonly StepDescriptor[] = [
  {
    key: "law",
    label: "Legal basis",
    route: "/law/create",
    envelope: "law",
    build: ({ entity }) => entity.law,
  },
  {
    key: "legal_person",
    label: "Legal person",
    route: "/legal_person/create",
    envelope: "legalPerson",
    build: ({ entity, state }) => [{ ...entity.legalPerson, law: ids(state, "law") }],
  },
  {
    key: "identifier",
    label: "Organisation identifiers",
    route: "/identifier/create",
    envelope: "identifier",
    build: ({ entity }) => entity.identifiers,
  },
  {
    key: "legal_entity",
    label: "Legal entity",
    route: "/legal_entity/create",
    envelope: "legal_entity",
    build: ({ entity, state }) => [
      {
        ...entity.legalEntity,
        identifiers: ids(state, "identifier"),
        legal_person_id: firstId(state, "legal_person"),
      },
    ],
  },
  {
    // Two policies, distinguished by `intention`. The provider takes the `wrp` one and the
    // intended use takes the `intended_use` one; mixing them is rejected.
    key: "policy_wrp",
    label: "Policy (relying party)",
    route: "/policy/create",
    envelope: "policy",
    build: ({ entity }) => [{ ...entity.policies.wrp, intention: "wrp" }],
  },
  {
    key: "provider",
    label: "Provider",
    route: "/provider/create",
    envelope: "provider",
    build: ({ entity, state }) => [
      {
        ...entity.provider,
        legalEntityId: firstId(state, "legal_entity"),
        policy_id: ids(state, "policy_wrp"),
      },
    ],
  },
  {
    key: "credential",
    label: "Credentials requested",
    route: "/credential/create",
    envelope: "credentials",
    build: ({ entity }) => entity.credentials,
  },
  {
    key: "policy_intended_use",
    label: "Policy (intended use)",
    route: "/policy/create",
    envelope: "policy",
    build: ({ entity }) => [{ ...entity.policies.intendedUse, intention: "intended_use" }],
  },
  {
    key: "intended_use",
    label: "Intended use",
    route: "/intended_use/create",
    envelope: "intended_uses",
    build: ({ entity, state }) => [
      {
        ...entity.intendedUse,
        credential_ids: ids(state, "credential"),
        privacyPolicy_id: ids(state, "policy_intended_use"),
      },
    ],
  },
  {
    key: "provided_attestation",
    label: "Attestations provided",
    route: "/provided_attestation/create",
    envelope: "providesAttestations",
    build: ({ entity }) => entity.providedAttestations,
  },
  {
    key: "supervisory_authority",
    label: "Supervisory authority",
    route: "/supervisory_authority/create",
    envelope: "supervisoryAuthority",
    build: ({ entity }) => [entity.supervisoryAuthority],
  },
  {
    // Where both roles meet: one registration carrying both entitlements, which is how twenty of
    // the 122 entities in the live register are shaped. ARF §6.3.2.3 dual-role registration.
    key: "wallet_rp",
    label: "Wallet Relying Party",
    route: "/wallet_rp/create",
    envelope: "WalletRelyingParty",
    build: ({ entity, state }) => [
      {
        ...entity.walletRelyingParty,
        provider_id: firstId(state, "provider"),
        intendedUse_ids: ids(state, "intended_use"),
        providesAttestations_id: ids(state, "provided_attestation"),
        supervisoryAuthority: firstId(state, "supervisory_authority"),
      },
    ],
  },
];

export interface StepStatus {
  readonly key: string;
  readonly label: string;
  readonly route: string;
  readonly done: boolean;
  readonly ids: readonly number[];
}

export const stepStatuses = (state: SessionState): readonly StepStatus[] =>
  STEPS.map((step) => ({
    key: step.key,
    label: step.label,
    route: step.route,
    done: (state[step.key]?.length ?? 0) > 0,
    ids: state[step.key] ?? [],
  }));

/** The body a step would send, with `hash_pid` replaced — for a rehearsal, or for a screen. */
export const previewStep = (step: StepDescriptor, context: StepContext): unknown => ({
  hash_pid: "<redacted>",
  [step.envelope]: step.build(context),
});

export interface StepOutcome {
  readonly key: string;
  readonly label: string;
  readonly ids: readonly number[];
  readonly skipped: boolean;
}

/**
 * Runs the chain, skipping steps already recorded.
 *
 * `onStep` is called after each one so a caller can report progress as it happens rather than at
 * the end; a fourteen-call chain against a remote service is long enough that a silent wait is
 * indistinguishable from a hang.
 */
export const runChain = async (
  entity: RegistrationEntity,
  options: ClientOptions & { readonly onStep?: (outcome: StepOutcome) => void } = {},
): Promise<readonly StepOutcome[]> => {
  const resolved = resolve(options);
  const hashPid = readHashPid(resolved.store);
  if (!hashPid) throw new Error("no hash_pid: log in first");

  const outcomes: StepOutcome[] = [];
  let state = readState(resolved.store);

  for (const step of STEPS) {
    const existing = state[step.key];
    if (existing && existing.length > 0) {
      const outcome = { key: step.key, label: step.label, ids: existing, skipped: true };
      outcomes.push(outcome);
      options.onStep?.(outcome);
      continue;
    }

    const body = { hash_pid: hashPid, [step.envelope]: step.build({ entity, state }) };
    const response = (await request(resolved, "POST", step.route, body)) as {
      data?: readonly number[];
    };
    const minted = response?.data;
    if (!Array.isArray(minted) || minted.length === 0) {
      throw new Error(`${step.route} returned no data array; refusing to continue the chain`);
    }

    state = recordIds(resolved.store, step.key, minted);
    const outcome = { key: step.key, label: step.label, ids: minted, skipped: false };
    outcomes.push(outcome);
    options.onStep?.(outcome);
  }

  return outcomes;
};

// --- the certificates --------------------------------------------------------------------

export interface CertificateResult {
  readonly path: string;
  readonly bytes: number;
}

/**
 * Mints the PKCS#12 access certificate and writes it to the session directory, mode 600.
 *
 * Written server-side rather than returned to a browser on purpose: a download would put a private
 * key in the operator's `Downloads` folder, world-readable by every other process running as them,
 * and leave a copy nobody remembers to delete.
 *
 * The passphrase is chosen by the caller — the service does not generate one — and protects the
 * private key from here on. It is never stored.
 */
export const issueAccessCertificate = async (
  passphrase: string,
  options: ClientOptions = {},
): Promise<CertificateResult> => {
  const resolved = resolve(options);
  const hashPid = readHashPid(resolved.store);
  if (!hashPid) throw new Error("no hash_pid: log in first");
  if (passphrase.length === 0) {
    throw new Error("an empty passphrase is not acceptable for a private key");
  }

  const state = readState(resolved.store);
  const wrpId = firstId(state, "wallet_rp");
  if (wrpId === undefined) throw new Error("no Wallet Relying Party yet: run the chain first");

  const target = join(resolved.store.directory, "rpac.p12");
  if (existsSync(target)) {
    throw new Error(`${target} already exists; move it aside before reissuing`);
  }

  const response = (await request(resolved, "POST", "/wallet_rp/certificate", {
    hash_pid: hashPid,
    wrp_id: wrpId,
    password: passphrase,
  })) as { data?: { file_base64?: string } };

  const encoded = response?.data?.file_base64;
  if (!encoded || encoded.length === 0) {
    // Checked rather than assumed: the P12 arrives base64-encoded inside a JSON field, so a
    // missing field would otherwise write a plausible empty file that only failed later, during
    // the chain check, where it would look like a chain problem.
    throw new Error("the certificate response carried no data.file_base64");
  }

  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0) throw new Error("the decoded PKCS#12 is empty");
  writeFileSync(target, bytes, { mode: 0o600 });
  chmodSync(target, 0o600);
  return { path: target, bytes: bytes.length };
};

/**
 * Mints the registration certificate for the intended use.
 *
 * One per intended use, not one per service: the route is keyed by `intended_use_id`, which is
 * `RPRC_19` expressed in a URL. Its encoding is documented as JAdES and COSE and is **unverified**
 * — whether the response is a JWT, a JSON envelope or a detached signature has not been seen — so
 * the response is stored verbatim rather than parsed into something it might not be.
 */
export const issueRegistrationCertificate = async (
  options: ClientOptions = {},
): Promise<CertificateResult> => {
  const resolved = resolve(options);
  const hashPid = readHashPid(resolved.store);
  if (!hashPid) throw new Error("no hash_pid: log in first");

  const state = readState(resolved.store);
  const intendedUseId = firstId(state, "intended_use");
  if (intendedUseId === undefined) throw new Error("no intended use yet: run the chain first");

  const response = await request(resolved, "POST", "/intended_use/certificate", {
    hash_pid: hashPid,
    intended_use_id: intendedUseId,
  });

  const target = join(resolved.store.directory, `rprc-intended-use-${intendedUseId}.jwt`);
  const serialised =
    typeof response === "string" ? response : JSON.stringify(response, null, 2);
  writeFileSync(target, serialised, { mode: 0o600 });
  chmodSync(target, 0o600);
  return { path: target, bytes: Buffer.byteLength(serialised) };
};
