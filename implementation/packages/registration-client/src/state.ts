import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where a registration session keeps what it has done.
 *
 * ## One file on disk, shared by every consumer
 *
 * The console and the CLI are two front ends over the same session, so the session cannot live in
 * either of them. It lives in a file, which is also what makes an interrupted registration
 * resumable — and resumability is not a nicety here: the service mints integer ids, has no
 * idempotency key, and offers no route to amend a half-built registration
 * (`docs/interop-findings.md` C9). Re-running from the start would create a second set of
 * entities, not reuse the first.
 *
 * It also keeps the console honest about the non-goal in `docs/web-interface-proposal.md` §7 —
 * "the console stores nothing of its own". It does not: it reads and writes the session file the
 * CLI also drives.
 *
 * ## Why the directory is outside the repository
 *
 * `hash_pid` is a secret. It is on the log-redaction deny list and `*hash_pid*` is gitignored, but
 * neither of those is a reason to keep it in the tree. The default location is under `$HOME`, mode
 * 700, so it cannot be committed by accident at all.
 */

export const defaultDirectory = (): string =>
  process.env["EDTP_REGISTRATION_DIR"] ?? join(homedir(), ".edtp", "registration");

/** Ids only. No secrets: `hash_pid` has its own file and a passphrase is never stored. */
export type SessionState = Readonly<Record<string, readonly number[]>>;

export interface SessionStore {
  readonly directory: string;
  readonly statePath: string;
  readonly hashPidPath: string;
}

export const openStore = (directory = defaultDirectory()): SessionStore => {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // `mkdirSync` honours the mode only on creation, so an existing directory is tightened here.
  chmodSync(directory, 0o700);
  return {
    directory,
    statePath: join(directory, "state.json"),
    hashPidPath: join(directory, "hash_pid"),
  };
};

export const readState = (store: SessionStore): SessionState => {
  if (!existsSync(store.statePath)) return {};
  const parsed: unknown = JSON.parse(readFileSync(store.statePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `${store.statePath} is not a JSON object; refusing to guess at its contents`,
    );
  }
  return parsed as SessionState;
};

/**
 * Writes through a temporary file in the same directory, then renames.
 *
 * A torn state file is worse than no state file: it would either lose ids for entities that exist
 * — leaving them orphaned and the session unresumable — or, if it lost only the tail, cause the
 * next run to recreate entities that are already registered. `rename` within one directory is
 * atomic, so a crash mid-write leaves the previous state intact.
 */
export const writeState = (store: SessionStore, state: SessionState): void => {
  const temporary = `${store.statePath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, store.statePath);
  chmodSync(store.statePath, 0o600);
};

export const recordIds = (
  store: SessionStore,
  key: string,
  ids: readonly number[],
): SessionState => {
  const next = { ...readState(store), [key]: ids };
  writeState(store, next);
  return next;
};

// --- hash_pid ---------------------------------------------------------------------------
// Its own file, so that reading session progress never touches the secret. Nothing in this module
// returns it except `readHashPid`, which exists for the one caller that must put it in a request
// body.

export const storeHashPid = (store: SessionStore, hashPid: string): void => {
  writeFileSync(store.hashPidPath, hashPid, { mode: 0o600 });
  chmodSync(store.hashPidPath, 0o600);
};

export const readHashPid = (store: SessionStore): string | undefined => {
  const fromEnvironment = process.env["HASH_PID"];
  if (fromEnvironment) return fromEnvironment;
  if (!existsSync(store.hashPidPath)) return undefined;
  const value = readFileSync(store.hashPidPath, "utf8").trim();
  return value.length > 0 ? value : undefined;
};

/**
 * A digest of `hash_pid`, for display and for comparison.
 *
 * This is the only form in which the value may reach a screen, a log or a session record. It
 * exists for one question the runbook leaves open and marks as not-to-be-relied-on: whether
 * `hash_pid` is stable across a **re-issued** PID for the same synthetic identity. Answering it
 * means comparing two logins, and comparing digests answers it exactly as well as comparing values
 * would, without ever revealing either.
 *
 * Truncated to 16 hex characters: enough that a collision is not a practical concern for comparing
 * two values, short enough to read off a screen and write into a run record by hand.
 */
export const fingerprint = (hashPid: string): string =>
  createHash("sha256").update(hashPid, "utf8").digest("hex").slice(0, 16);

export const hashPidFingerprint = (store: SessionStore): string | undefined => {
  const value = readHashPid(store);
  return value === undefined ? undefined : fingerprint(value);
};

// --- the stability question --------------------------------------------------------------
// `docs/certificate-intake-runbook.md` records, as unverified and not to be relied on, whether
// `hash_pid` is stable across a **re-issued** PID for the same synthetic identity. The whole risk
// profile of a registration turns on it: if it is stable, losing the wallet installation does not
// lose the ability to manage the registrations, and if it is not, the installation is
// irreplaceable.
//
// Answering it means authenticating twice, either side of a re-issuance, and comparing. So a login
// archives the previous value instead of overwriting it, and the comparison is of digests — which
// settles the question exactly as well as comparing values would, without either value being
// displayed, logged or written into a run record.
//
// This is only safe to do **before** anything is registered. Afterwards, deleting the PID that
// holds the login would be unthinkable.

const previousPath = (store: SessionStore): string => `${store.hashPidPath}.previous`;

/** Moves the current value aside, so the next login can be compared against it. */
export const archiveHashPid = (store: SessionStore): boolean => {
  if (!existsSync(store.hashPidPath)) return false;
  renameSync(store.hashPidPath, previousPath(store));
  chmodSync(previousPath(store), 0o600);
  return true;
};

export const previousHashPidFingerprint = (store: SessionStore): string | undefined => {
  const path = previousPath(store);
  if (!existsSync(path)) return undefined;
  const value = readFileSync(path, "utf8").trim();
  return value.length > 0 ? fingerprint(value) : undefined;
};

export type StabilityVerdict = "stable" | "changed" | "unknown";

/**
 * Compares the current login against the archived one.
 *
 * `unknown` covers both "only one login so far" and "no login at all"; neither is a result, and
 * reporting them as one would be worse than saying nothing.
 */
export const stabilityVerdict = (store: SessionStore): StabilityVerdict => {
  const current = hashPidFingerprint(store);
  const previous = previousHashPidFingerprint(store);
  if (current === undefined || previous === undefined) return "unknown";
  return current === previous ? "stable" : "changed";
};
