import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The hosted-form gate in front of the engine's authorization endpoint.
 *
 * The engine's built-in authorization server mints a code the moment a browser arrives at
 * `/issuers/{tenant}/authorize`; it has no page of its own and no hook to add one. For wallet-initiated
 * issuance the person must fill in the platform's hosted form first, so this gateway sends them there,
 * and lets them on to the engine only with the pass the platform hands the form on a valid submission.
 * Kept apart from `main.ts`, which starts the servers when imported, so it can be tested.
 */
const AUTHORIZE = /^\/issuers\/([A-Za-z0-9._-]+)\/authorize$/;

/** The pass the platform gives the hosted form. Must match `hostedFormAuthorizePass` there. */
export const hostedFormAuthorizePass = (
  secret: string,
  engineTenantRef: string,
  requestUri: string,
): string =>
  createHmac("sha256", secret).update(`${engineTenantRef}\n${requestUri}`).digest("base64url");

export type Gate =
  | { readonly kind: "none" }
  | { readonly kind: "redirect"; readonly location: string; readonly tenant: string }
  | { readonly kind: "refuse"; readonly reason: string }
  | { readonly kind: "pass"; readonly forwardUrl: string };

/**
 * Decides what happens to a browser at a hosted-form tenant's authorization endpoint.
 *
 * Without a valid pass it goes to the form, carrying the wallet's `request_uri` and `client_id` and
 * nothing else. With one it goes on to the engine, the pass removed. A pass is an HMAC over the
 * tenant and that `request_uri`, so it opens exactly one authorization request and cannot be
 * minted by anyone without the platform's secret.
 */
export const hostedFormGate = (
  config: {
    readonly GATEWAY_HOSTED_FORM_URL?: string | undefined;
    readonly GATEWAY_HOSTED_FORM_AUTHORIZE_SECRET?: string | undefined;
    readonly GATEWAY_HOSTED_FORM_TENANTS: readonly string[];
  },
  method: string,
  rawUrl: string,
): Gate => {
  const formUrl = config.GATEWAY_HOSTED_FORM_URL;
  const secret = config.GATEWAY_HOSTED_FORM_AUTHORIZE_SECRET;
  if (!formUrl || !secret || method !== "GET") return { kind: "none" };
  const url = new URL(rawUrl, "http://gateway.invalid");
  const tenant = AUTHORIZE.exec(url.pathname)?.[1];
  if (!tenant || !config.GATEWAY_HOSTED_FORM_TENANTS.includes(tenant)) return { kind: "none" };

  const requestUri = url.searchParams.get("request_uri");
  if (!requestUri) return { kind: "refuse", reason: "authorize_without_request_uri" };
  const presented = url.searchParams.get("edtp_pass");
  const expected = hostedFormAuthorizePass(secret, tenant, requestUri);
  if (presented && safeEqual(presented, expected)) {
    url.searchParams.delete("edtp_pass");
    return { kind: "pass", forwardUrl: `${url.pathname}${url.search}` };
  }

  const location = new URL(formUrl);
  location.searchParams.set("tenant", tenant);
  location.searchParams.set("request_uri", requestUri);
  const clientId = url.searchParams.get("client_id");
  if (clientId) location.searchParams.set("client_id", clientId);
  return { kind: "redirect", location: location.toString(), tenant };
};

const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
