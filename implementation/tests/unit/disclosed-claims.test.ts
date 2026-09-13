import { extractDisclosedClaims, restoreRequestedShape } from "@edtp/eudiplo-adapter";
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

describe("mdoc values are put back where the claim paths address them", () => {
  /**
   * `interop-findings.md` A24, and the second time the same shape of defect has cost a wallet run.
   *
   * An mdoc claim path is `[namespace, element]`. The engine returns the element **flat**, so the
   * result policy reads `disclosed["org.iso.18013.5.1"]`, finds nothing, and reports the policy
   * unsatisfied — for a presentation the engine verified successfully.
   *
   * The fixture is the shape captured from the first mdoc presentation ever made against this
   * platform, on 13 September 2026, with the value replaced. The engine's own session said
   * `outcome.result: "success"` and `verified: true`; the platform answered `POLICY_NOT_SATISFIED`.
   */
  const asClaims = (paths: (string | number | null)[][]) => paths.map((path) => ({ path }));

  it("nests a flat element under the namespace that was asked for", () => {
    expect(
      restoreRequestedShape(
        { family_name: "Ted" },
        asClaims([["org.iso.18013.5.1", "family_name"]]),
      ),
    ).toEqual({ "org.iso.18013.5.1": { family_name: "Ted" } });
  });

  it("leaves a value alone when it already sits where the path addresses it", () => {
    // SD-JWT VC, where the engine's shape already matches. Moving it would be the bug, not the fix.
    const already = { address: { locality: "Barcelona" } };
    expect(restoreRequestedShape(already, asClaims([["address", "locality"]]))).toEqual(
      already,
    );
  });

  it("keeps anything no requested path re-homed", () => {
    // The envelope is stripped earlier; whatever else survives is passed through rather than lost to
    // a transformation that only knew about the claims it was given.
    expect(
      restoreRequestedShape(
        { family_name: "Ted", something_else: 1 },
        asClaims([["org.iso.18013.5.1", "family_name"]]),
      ),
    ).toEqual({ "org.iso.18013.5.1": { family_name: "Ted" }, something_else: 1 });
  });

  it("does nothing when every requested path is a single segment", () => {
    const flat = { birthdate: "1990-05-20" };
    expect(restoreRequestedShape(flat, asClaims([["birthdate"]]))).toEqual(flat);
  });

  it("groups several elements of one namespace", () => {
    expect(
      restoreRequestedShape(
        { family_name: "Ted", age_over_18: true },
        asClaims([
          ["org.iso.18013.5.1", "family_name"],
          ["org.iso.18013.5.1", "age_over_18"],
        ]),
      ),
    ).toEqual({ "org.iso.18013.5.1": { family_name: "Ted", age_over_18: true } });
  });
});
