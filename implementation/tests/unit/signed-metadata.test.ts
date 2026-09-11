/**
 * What `signed_metadata` has to carry, per ETSI TS 119 472-3 V1.1.1.
 *
 * The engine at the pinned version emits no `signed_metadata` at all, so none of this is reachable
 * against a live engine yet — which is exactly why it is unit-tested. When a release adds support,
 * the platform must report what is actually there rather than inferring gate (a) from the presence
 * of the claim alone.
 *
 * Clauses under test:
 *   ISS-MDATA-ACC_CERT-4.2.2-01/-02  `x5c` in the protected header, carrying the access certificate
 *   ISS-MDATA-REG_CERT-4.2.3-02/-04  `issuer_info` at the top level of the signed payload, one
 *                                    element of which may carry the registration certificate
 */

import { inspectSignedMetadata } from "@edtp/eudiplo-adapter";
import { describe, expect, it } from "vitest";

const b64url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

const jws = (header: unknown, payload: unknown): string =>
  `${b64url(header)}.${b64url(payload)}.c2lnbmF0dXJl`;

const registrationCertEntry = { format: "registration_cert", data: "eyJ…" };

describe("inspectSignedMetadata", () => {
  it("reports both requirements met for a conformant JWS", () => {
    const result = inspectSignedMetadata(
      jws(
        { alg: "ES256", x5c: ["MIIB…leaf", "MIIB…intermediate"] },
        { iss: "https://issuer.test", issuer_info: [registrationCertEntry] },
      ),
    );
    expect(result).toEqual({ hasX5c: true, hasIssuerInfo: true });
  });

  it("reports no access certificate when the header has no x5c", () => {
    // A signed document whose signer cannot be identified. ISS-MDATA-4.2.1-02 makes the access
    // certificate the signing certificate, so without x5c there is nothing to validate against the
    // WRPAC anchors — the signature alone does not satisfy gate (a).
    const result = inspectSignedMetadata(
      jws({ alg: "ES256", kid: "key-1" }, { issuer_info: [registrationCertEntry] }),
    );
    expect(result).toEqual({ hasX5c: false, hasIssuerInfo: true });
  });

  it("treats an empty x5c array as no certificate", () => {
    const result = inspectSignedMetadata(jws({ alg: "ES256", x5c: [] }, { issuer_info: [] }));
    expect(result).toEqual({ hasX5c: false, hasIssuerInfo: false });
  });

  it("does not accept an issuer_info array that carries no registration certificate", () => {
    // `-04` makes the registration certificate one possible element. An `issuer_info` carrying only
    // other entries is well-formed and still leaves the provider unauthenticated.
    const result = inspectSignedMetadata(
      jws({ x5c: ["MIIB…"] }, { issuer_info: [{ format: "something_else", data: "x" }] }),
    );
    expect(result).toEqual({ hasX5c: true, hasIssuerInfo: false });
  });

  it("does not accept issuer_info outside the signed payload", () => {
    // The engine's current shape: `issuer_info` in the unsigned document. Here the payload has none,
    // which is what the platform must report even when the unsigned document does carry one.
    const result = inspectSignedMetadata(
      jws({ x5c: ["MIIB…"] }, { iss: "https://issuer.test" }),
    );
    expect(result).toEqual({ hasX5c: true, hasIssuerInfo: false });
  });

  it("reports a malformed value as not signed rather than throwing", () => {
    // This runs inside a read-only diagnostic endpoint, so a malformed claim must degrade to "no
    // signed metadata" instead of failing the request.
    expect(inspectSignedMetadata("not-a-jws")).toBeUndefined();
    expect(inspectSignedMetadata("only.two")).toBeUndefined();
    expect(inspectSignedMetadata("!!!.!!!.sig")).toBeUndefined();
    expect(inspectSignedMetadata(`${b64url([1, 2])}.${b64url({})}.sig`)).toBeUndefined();
    expect(inspectSignedMetadata("")).toBeUndefined();
  });
});
