import { sandboxMetadataForward } from "@edtp/test-gateway/sandbox-metadata.js";
import { describe, expect, it } from "vitest";

/** The one engine path the gateway sends to the platform (S5b, ADR 0016). */
describe("sandboxMetadataForward", () => {
  it("sends a sandbox issuer's metadata GET to the platform's signing route", () => {
    expect(
      sandboxMetadataForward(
        "GET",
        "/.well-known/openid-credential-issuer/issuers/sbx-iss-abc123def456",
      ),
    ).toBe("/sandbox/public/issuer-metadata/sbx-iss-abc123def456");
  });

  it("leaves every other path, issuer and method to the engine", () => {
    for (const [method, path] of [
      ["GET", "/.well-known/openid-credential-issuer/issuers/pid-1"],
      ["GET", "/.well-known/openid-credential-issuer/issuers/sbx-rp-abc123def456"],
      ["GET", "/.well-known/openid-credential-issuer/issuers/sbx-iss-abc123def456/extra"],
      ["GET", "/.well-known/oauth-authorization-server/issuers/sbx-iss-abc123def456"],
      ["POST", "/.well-known/openid-credential-issuer/issuers/sbx-iss-abc123def456"],
    ] as const) {
      expect(sandboxMetadataForward(method, path), `${method} ${path}`).toBeUndefined();
    }
  });
});
