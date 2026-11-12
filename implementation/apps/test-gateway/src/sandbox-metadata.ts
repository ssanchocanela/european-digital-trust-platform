/**
 * The one engine path the gateway sends elsewhere (sandbox S5b, ADR 0016): a sandbox issuer's
 * Credential Issuer metadata, which the platform signs because the engine signs nothing.
 *
 * Only `GET`, only engine tenants of the sandbox's hosted issuers (`sbx-iss-` and twelve characters,
 * as `EngineTenantService.newRef` makes them), and only with `GATEWAY_SANDBOX_SIGNED_METADATA` on.
 * Every other issuer's metadata still comes from the engine, unsigned, as before.
 */
const SANDBOX_ISSUER_METADATA =
  /^\/\.well-known\/openid-credential-issuer\/issuers\/(sbx-iss-[a-z0-9]{12})$/;

/** The platform path that serves it, or undefined when the request is not one to redirect. */
export function sandboxMetadataForward(method: string, pathname: string): string | undefined {
  if (method.toUpperCase() !== "GET") return undefined;
  const match = SANDBOX_ISSUER_METADATA.exec(pathname);
  return match ? `/sandbox/public/issuer-metadata/${match[1]}` : undefined;
}
