import { z } from "zod";

/**
 * Response schemas for the engine.
 *
 * Parsed rather than cast. The engine is on a fast release cadence — six releases in
 * 27 days at the time of Phase 0, including a CommonJS-to-ESM migration between two of
 * them — so a silently changed response shape is a realistic failure mode. Parsing
 * turns it into a loud one at the adapter boundary, which is where it belongs.
 *
 * Every schema is permissive about fields the platform does not read (`passthrough`),
 * because the engine adding a field must not break the platform, and strict about the
 * ones it does.
 */

/** `POST /verifier/offer` and `POST /issuer/offer` share this response shape. */
export const engineOfferResponseSchema = z
  .object({
    uri: z.string().min(1),
    /** Present for the cross-device variant, which omits the completion redirect. */
    crossDeviceUri: z.string().min(1).optional(),
    session: z.string().min(1),
  })
  .passthrough();

export type EngineOfferResponse = z.infer<typeof engineOfferResponseSchema>;

/**
 * The structured verification outcome the engine persists on the session (v7.5.0+).
 *
 * Machine-readable `result` and `error` are what the adapter branches on;
 * `message` is short and safe for display. Per-credential detail is present but the
 * platform reads only the top level, because a V0 policy requests one credential.
 */
export const engineSessionOutcomeSchema = z
  .object({
    result: z.string().optional(),
    error: z.string().optional(),
    message: z.string().optional(),
    credentials: z.array(z.unknown()).optional(),
  })
  .passthrough();

/**
 * `GET /session/:id`.
 *
 * `verifiedClaims` is **content**: disclosed attribute values keyed by DCQL credential
 * id. It is parsed as an opaque record and handed straight to the result policy, which
 * runs in the same call stack. It is never persisted and never logged.
 *
 * `status` is typed as a plain string rather than an enum on purpose: a status the
 * adapter does not recognise must degrade to "still waiting" rather than throw, and the
 * outcome mapping handles the unknown case explicitly.
 */
export const engineSessionSchema = z
  .object({
    id: z.string().min(1),
    status: z.string(),
    createdAt: z.union([z.string(), z.date()]).optional(),
    updatedAt: z.union([z.string(), z.date()]).optional(),
    expiresAt: z.union([z.string(), z.date()]).nullish(),
    consumedAt: z.union([z.string(), z.date()]).nullish(),
    verifiedClaims: z.record(z.string(), z.unknown()).nullish(),
    outcome: engineSessionOutcomeSchema.nullish(),
    failureCode: z.string().nullish(),
    errorReason: z.string().nullish(),
  })
  .passthrough();

export type EngineSessionResponse = z.infer<typeof engineSessionSchema>;

/** `POST /key-chain` and `POST /key-chain/import`. */
export const keyChainIdSchema = z.object({ id: z.string().min(1) }).passthrough();

/** `PUT /session-config`. The platform asserts the values it set were applied. */
export const engineSessionConfigSchema = z
  .object({
    ttlSeconds: z.number().int().optional(),
    cleanupMode: z.string().optional(),
  })
  .passthrough();
