import { extractDisclosedClaims } from "@edtp/eudiplo-adapter";
import { describe, expect, it } from "vitest";

/**
 * The disclosed-claims extraction, pinned against the shape a **real** engine session has.
 *
 * These exist because the adapter read a field that does not exist — `verifiedClaims` — and got
 * away with it through 21 contract tests against a live engine. The reason it got away with it is
 * the reason this file is a unit test rather than another contract test: **no test that lacks a
 * wallet can produce a verified presentation**, so the claims field is empty in all of them, and an
 * empty field is indistinguishable from an absent one.
 *
 * The fixture below is therefore not invented. It is the shape captured from a completed session on
 * 13 September 2026, after a modified wallet presented a PID — `interop-findings.md` A18 — with the
 * attribute value replaced by a synthetic one.
 */

/** Exactly the shape `GET /api/session/{id}` returned, values replaced. */
const completedSession = {
  id: "0618f79c-3ab5-4105-b399-7f050fe4a5f5",
  status: "completed",
  outcome: { result: "success", credentials: [{ id: "urn-eudi-pid-1-sdjwt", verified: true }] },
  credentials: [
    {
      id: "urn-eudi-pid-1-sdjwt",
      values: [
        {
          iss: "https://issuer.example",
          iat: 1_789_000_000,
          exp: 1_789_900_000,
          vct: "urn:eudi:pid:1",
          birthdate: "1990-05-20",
        },
      ],
    },
  ],
};

describe("disclosed claims, against the real engine shape", () => {
  it("reads the claims out of credentials[].values[]", () => {
    expect(extractDisclosedClaims(completedSession)).toEqual({ birthdate: "1990-05-20" });
  });

  it("drops the SD-JWT envelope rather than passing it to the result policy", () => {
    // OIA_16 obliges the Relying Party Instance to discard timestamps as soon as they are no
    // longer needed and never to communicate them. The earliest point that can happen is here,
    // where content crosses out of the engine — not at the result boundary.
    const claims = extractDisclosedClaims(completedSession) ?? {};
    for (const key of ["iss", "iat", "exp", "vct", "cnf", "status", "_sd", "_sd_alg"]) {
      expect(claims).not.toHaveProperty(key);
    }
  });

  it("returns nothing when the engine reports no credentials", () => {
    // The pre-fix behaviour for *every* real session, because it read an absent field. A
    // transaction settles PROTOCOL_ERROR on this, so it must mean "genuinely nothing".
    expect(extractDisclosedClaims({ ...completedSession, credentials: [] })).toBeUndefined();
    expect(
      extractDisclosedClaims({ id: "x", status: "completed" } as typeof completedSession),
    ).toBeUndefined();
  });

  it("returns nothing when the envelope is all that was disclosed", () => {
    expect(
      extractDisclosedClaims({
        ...completedSession,
        credentials: [{ id: "urn-eudi-pid-1-sdjwt", values: [{ iss: "x", iat: 1, vct: "y" }] }],
      }),
    ).toBeUndefined();
  });

  it("refuses more credentials than the policy asked for", () => {
    // Merging would silently accept a credential the policy never requested.
    expect(() =>
      extractDisclosedClaims({
        ...completedSession,
        credentials: [
          { id: "urn-eudi-pid-1-sdjwt", values: [{ birthdate: "1990-05-20" }] },
          { id: "something-else", values: [{ family_name: "Doe" }] },
        ],
      }),
    ).toThrow(/more disclosed credentials/);
  });

  it("refuses more than one instance of the requested credential", () => {
    expect(() =>
      extractDisclosedClaims({
        ...completedSession,
        credentials: [
          {
            id: "urn-eudi-pid-1-sdjwt",
            values: [{ birthdate: "1990-05-20" }, { birthdate: "1985-01-01" }],
          },
        ],
      }),
    ).toThrow(/more than one instance/);
  });
});
