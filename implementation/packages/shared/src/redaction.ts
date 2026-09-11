/**
 * Log redaction.
 *
 * ARF `AS-RP-01-002` (`OIA_16`) requires a Relying Party Instance to discard the
 * values of all unique elements listed in `AS-AP-10-064` (`ISSU_35`) — per-attribute
 * salts, attribute hash values, the revocation index, the device-binding public key
 * and the Attestation Provider signature value — as well as any timestamps, as soon
 * as they are no longer needed, and never to communicate them onward.
 *
 * A log line is "onward communication". This module is the enforcement point, and
 * `redaction.test.ts` fails the build if a denied key survives redaction.
 */

/**
 * Keys whose values must never reach a log, an audit record or a customer-facing
 * payload. Matched case-insensitively against the key name, and also as a
 * substring for the structural markers (`_sd`, `salt`, `thumbprint`).
 */
export const DENIED_KEYS: readonly string[] = [
  // Presentation and issuance content
  "vp_token",
  "vptoken",
  "presentation",
  "presentations",
  "presentedclaims",
  "verifiedclaims",
  "credential",
  "credentials",
  "credentialclaims",
  "credentialpayload",
  "claims",
  "claimvalues",
  "disclosures",
  "disclosure",
  "sdjwt",
  "sd_jwt",
  "mdoc",
  "deviceresponse",
  "issuerauth",
  "deviceauth",
  // ISSU_35 unique elements
  "salt",
  "_sd",
  "sd_hash",
  "sdhash",
  "thumbprint",
  "devicekey",
  "device_key",
  "cnf",
  "statuslistindex",
  "status_list_index",
  // PID attributes that must never be logged
  "birthdate",
  "birth_date",
  "portrait",
  "picture",
  "family_name",
  "given_name",
  "personal_administrative_number",
  "document_number",
  // Secrets and key material
  //
  // `hash_pid` is the bearer value the EUDI RP Registration Service returns from its
  // PID-presentation login. It authenticates the registration session, so it is a credential and
  // never belongs in a log line, an audit record or a document.
  "hash_pid",
  "hashpid",
  "p12",
  "pkcs12",
  "passphrase",
  "x5c",
  "privatejwk",
  "private_jwk",
  "privatekey",
  "private_key",
  "responseencryptionprivatejwk",
  "client_secret",
  "clientsecret",
  "password",
  "secret",
  "authorization",
  "apikey",
  "api_key",
  "token",
  "access_token",
  "bearer",
  "signature",
];

/** Substrings that deny a key wherever they appear in it. */
const DENIED_SUBSTRINGS: readonly string[] = [
  "_sd",
  "hash_pid",
  "passphrase",
  "salt",
  "thumbprint",
  "secret",
  "password",
  "privatekey",
  "private_key",
  "privatejwk",
];

export const REDACTED = "[REDACTED]";

const normalise = (key: string): string => key.toLowerCase();

export const isDeniedKey = (key: string): boolean => {
  const k = normalise(key);
  if (DENIED_KEYS.includes(k)) return true;
  return DENIED_SUBSTRINGS.some((s) => k.includes(s));
};

const MAX_DEPTH = 12;

/**
 * Recursively replaces the value of every denied key with `REDACTED`.
 *
 * Fails closed in two ways: an object deeper than `MAX_DEPTH` is replaced wholesale,
 * and a value that cannot be traversed (a class instance with unknown shape, a
 * function, a symbol) is replaced rather than serialised.
 */
export const redact = (input: unknown, depth = 0): unknown => {
  if (depth > MAX_DEPTH) return "[TRUNCATED]";
  if (input === null || input === undefined) return input;

  const t = typeof input;
  if (t === "string" || t === "number" || t === "boolean" || t === "bigint") return input;
  if (t === "function" || t === "symbol") return "[UNSERIALISABLE]";

  if (input instanceof Date) return input.toISOString();
  if (input instanceof Error) return { name: input.name, message: input.message };
  if (Array.isArray(input)) return input.map((v) => redact(v, depth + 1));

  if (input instanceof Map || input instanceof Set || ArrayBuffer.isView(input)) {
    return "[UNSERIALISABLE]";
  }

  if (t === "object") {
    const proto = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) {
      // Not a plain object. Redacting an unknown shape field-by-field risks
      // leaking a getter, so replace it.
      return "[UNSERIALISABLE]";
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      out[key] = isDeniedKey(key) ? REDACTED : redact(value, depth + 1);
    }
    return out;
  }

  return "[UNSERIALISABLE]";
};

/**
 * Scans an already-serialised string for denied key names. Used by the build-time
 * deny-list test as a second, independent check on emitted log lines.
 */
export const findDeniedKeysIn = (serialised: string): readonly string[] => {
  const found = new Set<string>();
  for (const key of DENIED_KEYS) {
    const pattern = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:`, "i");
    if (pattern.test(serialised)) found.add(key);
  }
  return [...found];
};
