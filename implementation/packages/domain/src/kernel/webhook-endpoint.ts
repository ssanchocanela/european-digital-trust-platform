import type { TenantId, WebhookEndpointId } from "@edtp/shared";
import { PlatformError } from "@edtp/shared";

/**
 * A tenant-scoped callback destination: its signing secret and its URL allow-list.
 *
 * ## Why this is in the shared kernel
 *
 * Milestone 1 put the signing secret and the allow-list on `RelyingPartyService`, which worked while
 * verification was the only thing that called back. It stopped working the moment issuance needed a
 * callback: an issuance has no Relying Party Service, so the delivery queue could not resolve a
 * secret for it. The two available bad answers were to sign issuance callbacks with a Relying Party's
 * secret — which would misattribute them — or to not deliver at all.
 *
 * The root cause was placement, not capability. Signing and SSRF protection are **shared
 * infrastructure**; a Relying Party Service is a verification-side concept. So the endpoint becomes
 * its own kernel object that both `RelyingPartyService` and `AttestationProvider` reference, and the
 * queue, HMAC signing, retry schedule and allow-list check from Milestone 1 are reused unchanged.
 *
 * ## What it deliberately is not
 *
 * Not a per-transaction URL. `POST /v1/presentations` and `POST /v1/issuances` may name a
 * `callbackUrl`, but only one already on this endpoint's allow-list — an arbitrary per-request URL is
 * refused. That is the SSRF control, and moving the allow-list here did not weaken it: the check is
 * the same function, against the same list, resolved one hop differently.
 */
export interface WebhookEndpoint {
  readonly id: WebhookEndpointId;
  readonly tenantId: TenantId;
  /** Operator-facing label. Not used in signing or matching. */
  readonly name: string;
  /**
   * HTTPS allow-list for callbacks.
   *
   * A request may only name a URL that matches an entry. Plain HTTP is refused outright: a signed
   * payload sent in clear is still a payload sent in clear.
   */
  readonly callbackUrlAllowList: readonly string[];
  readonly createdAt: Date;
}

/**
 * The secret is modelled separately from the endpoint.
 *
 * It is never returned by an API, never logged, and never part of a `WebhookEndpoint` that crosses a
 * layer boundary — so the type that travels cannot carry it by accident. The repository is the only
 * thing that reads it, and only to sign.
 */
export interface WebhookEndpointSecret {
  readonly endpointId: WebhookEndpointId;
  readonly secret: string;
}

/** Minimum length for a callback signing secret. 32 bytes of entropy, hex-encoded. */
export const MIN_WEBHOOK_SECRET_LENGTH = 64;

export const validateWebhookEndpoint = (input: {
  readonly name: string;
  readonly callbackUrlAllowList: readonly string[];
}): void => {
  const details: { path: string; code: string; message: string }[] = [];

  if (!input.name.trim()) {
    details.push({
      path: "name",
      code: "name_required",
      message: "A webhook endpoint needs a name, so an operator can tell two apart.",
    });
  }

  if (input.callbackUrlAllowList.length === 0) {
    details.push({
      path: "callbackUrlAllowList",
      code: "allow_list_required",
      message:
        "An endpoint with an empty allow-list can never deliver anything. Register at least one " +
        "HTTPS URL, or do not create the endpoint.",
    });
  }

  for (const [i, url] of input.callbackUrlAllowList.entries()) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      details.push({
        path: `callbackUrlAllowList[${i}]`,
        code: "allow_list_entry_invalid",
        message: "Each allow-list entry must be an absolute URL.",
      });
      continue;
    }
    if (parsed.protocol !== "https:") {
      details.push({
        path: `callbackUrlAllowList[${i}]`,
        code: "allow_list_entry_insecure",
        message:
          "Callback URLs must be HTTPS. A signed payload delivered in clear is still delivered in " +
          "clear.",
      });
    }
  }

  if (details.length > 0) {
    throw PlatformError.unprocessable(
      "webhook_endpoint_invalid",
      "The webhook endpoint is not valid.",
      details,
    );
  }
};

/**
 * Resolves a requested callback URL against an allow-list.
 *
 * Moved here from the presentation service unchanged, so **one** implementation serves verification
 * and issuance. Two implementations of an SSRF control is one too many: they drift, and the one that
 * drifts is the one nobody is looking at.
 *
 * Matching is **exact**, which is Milestone 1's rule kept deliberately. Prefix matching looks
 * friendlier and is weaker: a registered `https://host/hook` would authorise
 * `https://host/hook/../../internal`, and while `URL` normalises that particular string, relying on
 * normalisation to hold an SSRF boundary is the kind of assumption that breaks quietly. An exact list
 * means the set of reachable URLs is exactly the set somebody registered.
 */
export const resolveCallbackUrl = (requested: string, allowList: readonly string[]): string => {
  let target: URL;
  try {
    target = new URL(requested);
  } catch {
    throw PlatformError.validation(
      "callback_url_invalid",
      "The callback URL is not a valid absolute URL.",
    );
  }

  if (target.protocol !== "https:") {
    throw PlatformError.validation("callback_url_insecure", "A callback URL must use HTTPS.");
  }

  // Exact match, against the string as registered. Compared on the normalised `URL` form of both
  // sides so an equivalent spelling (default port, percent-encoding) is not rejected for cosmetics,
  // while anything not on the list still is.
  const permitted = allowList.some((entry) => {
    try {
      return new URL(entry).toString() === target.toString();
    } catch {
      return false;
    }
  });

  if (!permitted) {
    throw PlatformError.validation(
      "callback_url_not_allowed",
      "The callback URL is not on the registered allow-list for this webhook endpoint. An " +
        "arbitrary per-request URL is refused (SSRF protection).",
    );
  }

  return target.toString();
};
