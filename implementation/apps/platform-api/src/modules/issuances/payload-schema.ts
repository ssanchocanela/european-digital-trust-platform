import { PlatformError } from "@edtp/shared";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";

/**
 * Enforces a credential type's `payloadSchema` on the claims about to be issued.
 *
 * The claim list checks each attribute on its own. A Rulebook also states how attributes relate —
 * one block or the other and never both, constraints present only when a limitation is declared, a
 * closed code list — and a claim definition has no place for that. The schema does, and this is
 * where it stops an attestation that breaks it from being issued.
 *
 * ## What an error carries
 *
 * The **location** and the **rule** — `/ProxyPowerScope/0/Faculty`, `maximum` — and never the value
 * that broke it: what fails here is content (ADR 0004), and the error reaches the business client.
 * `ajv`'s own messages are built from the schema, not from the data, and are kept for that reason;
 * its `params` and `data` are not.
 *
 * ## Formats are not checked
 *
 * `format` (`uri`, `date`) is annotation only here: checking it needs a second dependency, and a
 * schema that relies on it should say the same thing with a `pattern`. Stated rather than implied.
 */
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });

/** Compiled validators by schema text. Bounded: a deployment has a handful of types. */
const compiled = new Map<string, ValidateFunction>();
const MAX_COMPILED = 64;

/**
 * Compiles a schema, or refuses it. Called when a type is created, so a schema that cannot be
 * compiled is refused then — not at the first issuance, in front of a person holding a phone.
 */
export const compilePayloadSchema = (
  schema: Readonly<Record<string, unknown>>,
): ValidateFunction => {
  const key = JSON.stringify(schema);
  const cached = compiled.get(key);
  if (cached) return cached;
  let validate: ValidateFunction;
  try {
    // A copy: plans are deep-frozen, and a compiler is entitled to annotate what it is given.
    validate = ajv.compile(structuredClone(schema) as Record<string, unknown>);
  } catch (error) {
    throw PlatformError.unprocessable(
      "payload_schema_invalid",
      "The credential type's payload schema cannot be compiled as JSON Schema 2020-12.",
      [
        {
          path: "payloadSchema",
          code: "payload_schema_invalid",
          message: error instanceof Error ? error.message : "Unknown schema error.",
        },
      ],
    );
  }
  if (compiled.size >= MAX_COMPILED) compiled.clear();
  compiled.set(key, validate);
  return validate;
};

/**
 * Refuses claims that do not satisfy the schema. `vct` is added, so one schema can distinguish the
 * attestation types a single Rulebook defines.
 */
export const assertPayloadSatisfiesSchema = (
  schema: Readonly<Record<string, unknown>>,
  vct: string | undefined,
  claims: Readonly<Record<string, unknown>>,
): void => {
  const validate = compilePayloadSchema(schema);
  if (validate({ ...(vct ? { vct } : {}), ...claims })) return;

  const details = (validate.errors ?? []).slice(0, 20).map((e) => ({
    path: e.instancePath || "/",
    code: `schema_${e.keyword}`,
    message: e.message ?? "does not satisfy the credential type's schema",
  }));
  throw PlatformError.unprocessable(
    "credential_payload_invalid",
    "The assembled claims do not satisfy the credential type's payload schema.",
    details,
  );
};
