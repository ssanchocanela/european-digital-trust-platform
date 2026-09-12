/**
 * Whether a phone could actually complete the interaction we are about to show.
 *
 * ## Why this exists
 *
 * The console happily rendered a QR carrying `http://localhost:3201/…` and a request object hosted at
 * `http://eudiplo:3000/…`. Both are unreachable from a phone — `localhost` **is the phone**, `eudiplo`
 * is a Docker-internal name — and the wallet refuses cleartext outright
 * (`network_security_config.xml`: `cleartextTrafficPermitted="false"`).
 *
 * So the operator scanned a valid QR, got an opaque failure, and had no way to tell whether the fault
 * was the wallet, the APK, the platform or the configuration. That is precisely the confusion this
 * console exists to remove, and producing an unusable QR in silence was a defect in it.
 *
 * These checks are **static**: they read the URLs and say what a phone would do with them. Nothing is
 * fetched, because reachability from *this* machine says nothing about reachability from a phone, and a
 * successful probe from the laptop would be actively misleading.
 */

export type ReachabilityProblem = {
  /** The variable an operator has to change. Named, because "check your config" is not actionable. */
  readonly setting: string;
  readonly value: string;
  readonly reason: string;
};

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "[::1]"]);

/** A hostname with no dot is a container or LAN alias — `eudiplo`, `platform-api`, `my-laptop`. */
const isInternalName = (hostname: string): boolean =>
  !hostname.includes(".") && !hostname.includes(":");

const inspect = (setting: string, rawUrl: string): ReachabilityProblem | undefined => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { setting, value: rawUrl, reason: "is not a URL a phone could open" };
  }

  if (LOOPBACK.has(url.hostname)) {
    return {
      setting,
      value: rawUrl,
      reason:
        "points at loopback. On a phone `localhost` is the phone itself, so it can never reach this " +
        "machine",
    };
  }
  if (isInternalName(url.hostname)) {
    return {
      setting,
      value: rawUrl,
      reason: `\`${url.hostname}\` resolves only inside the Docker network, not on a phone`,
    };
  }
  if (url.protocol !== "https:") {
    return {
      setting,
      value: rawUrl,
      reason:
        'is cleartext. The wallet sets `cleartextTrafficPermitted="false"`, so it refuses plain ' +
        "HTTP whatever the host is",
    };
  }
  return undefined;
};

/**
 * Everything a wallet would have to reach, checked together.
 *
 * The request object's host comes out of the interaction URI rather than from configuration, because
 * that is the value the engine actually emitted — reading `ENGINE_PUBLIC_URL` would report what we
 * *meant*, and the two have already diverged once (it was left at `http://eudiplo:3000` after a
 * conformance run).
 */
export const checkInteractionReachability = (input: {
  readonly interactionUri?: string;
  readonly startUrl?: string;
  readonly platformPublicUrl?: string;
}): readonly ReachabilityProblem[] => {
  const problems: ReachabilityProblem[] = [];

  if (input.startUrl) {
    const problem = inspect("TEST_START_PUBLIC_URL", input.startUrl);
    if (problem) {
      problems.push(problem);
    }
  }

  if (input.interactionUri) {
    const requestUri = requestUriOf(input.interactionUri);
    if (requestUri) {
      const problem = inspect("ENGINE_PUBLIC_URL", requestUri);
      if (problem) {
        problems.push(problem);
      }
    }
  }

  if (input.platformPublicUrl) {
    const problem = inspect("PLATFORM_PUBLIC_URL", input.platformPublicUrl);
    if (problem) {
      problems.push(problem);
    }
  }

  return problems;
};

/**
 * The `request_uri` a wallet would fetch.
 *
 * Returns `undefined` rather than throwing on anything unexpected: this runs while rendering a page,
 * and a diagnostic that breaks the page it is diagnosing is worse than one that says nothing.
 */
export const requestUriOf = (interactionUri: string): string | undefined => {
  try {
    const parsed = new URL(interactionUri);
    return parsed.searchParams.get("request_uri") ?? undefined;
  } catch {
    return undefined;
  }
};
