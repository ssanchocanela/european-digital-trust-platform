/**
 * What one organisation may create, so a participant cannot exhaust the sandbox (specification §8.3
 * and §11, "Abuse"). The engine-tenant quotas are the specification's v1 values; the daily ones are
 * the sandbox's own, set high enough for a full run of the defect catalogue in one day.
 *
 * Daily quotas count over the last 24 hours, not since midnight, so they cannot be doubled across a
 * date boundary.
 */
export const SANDBOX_QUOTAS = {
  /** Services an organisation registers. */
  servicesPerOrganisation: 10,
  /** Hosted verifiers, one engine tenant each (specification §8.3: 3). */
  hostedVerifiersPerOrganisation: 3,
  /** Hosted issuers, one engine tenant each (specification §8.3: 1). */
  hostedIssuersPerOrganisation: 1,
  /** Certificates issued for one service, take-away and hosted alike. */
  certificatesPerServicePerDay: 100,
  /** PID offers made by one hosted issuer. */
  offersPerServicePerDay: 100,
  /** Presentation runs started by one hosted verifier. */
  runsPerServicePerDay: 200,
} as const;

export type SandboxQuota = keyof typeof SANDBOX_QUOTAS;

export const QUOTA_WINDOW_MS = 86_400_000;

/** True when `used` already fills the quota, so one more is refused. */
export const quotaReached = (quota: SandboxQuota, used: number): boolean =>
  used >= SANDBOX_QUOTAS[quota];
