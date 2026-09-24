/**
 * Every trust-related configuration record carries an explicit trust environment.
 *
 * **V0 supports `TEST` only.** Production registration, certificates and Registrar
 * interactions are not faked: a record marked `PRODUCTION` is rejected at creation
 * until the legal qualification of the hosted Relying Party Instance profile is
 * confirmed (see `docs/knowledge-alignment.md` KA-3, open question Q2).
 */
export const TRUST_ENVIRONMENTS = ["TEST", "PRODUCTION"] as const;
export type TrustEnvironment = (typeof TRUST_ENVIRONMENTS)[number];

export const V0_SUPPORTED_TRUST_ENVIRONMENTS: readonly TrustEnvironment[] = ["TEST"];

export const isSupportedInV0 = (env: TrustEnvironment): boolean =>
  V0_SUPPORTED_TRUST_ENVIRONMENTS.includes(env);
