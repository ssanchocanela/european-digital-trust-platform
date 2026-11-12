import {
  QUOTA_WINDOW_MS,
  quotaReached,
  SANDBOX_QUOTAS,
  type SandboxQuota,
} from "@edtp/sandbox-domain";
import { PlatformError } from "@edtp/shared";

/**
 * Refuses the request that would exceed a quota (specification §11, "Abuse"). Checked before any
 * side effect, so a refused request creates no engine tenant, certificate or offer.
 */
export function assertQuota(quota: SandboxQuota, used: number): void {
  if (quotaReached(quota, used)) {
    throw PlatformError.conflict(
      "sandbox_quota_exceeded",
      `The sandbox quota ${quota} (${SANDBOX_QUOTAS[quota]}) is reached.`,
    );
  }
}

/** The start of the window a daily quota counts over: the last 24 hours. */
export const quotaWindowStart = (now: Date): Date => new Date(now.getTime() - QUOTA_WINDOW_MS);
