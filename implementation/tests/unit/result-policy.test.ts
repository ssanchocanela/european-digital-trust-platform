import type { DisclosedClaims, ResultPolicy } from "@edtp/domain";
import {
  applyResultPolicy,
  completedYearsBetween,
  findResultPolicyViolations,
} from "@edtp/domain";
import { describe, expect, it } from "vitest";

/**
 * Result policy behaviour.
 *
 * Two properties are load-bearing:
 *
 * - **The derived result must not carry the source value.** ADR 0005 Decision 5 makes
 *   derivation the primary route for an age check, because `age_over_18` was removed from
 *   the PID by PID Rulebook v1.1 following CIR 2024/2977. If the date of birth leaked into
 *   the output, the minimisation would be decorative.
 * - **`OIA_16` unique elements must be stripped from the customer-facing result**, not only
 *   from storage. `AS-RP-01-002` forbids communicating them to the Relying Party *or to any
 *   other party*.
 */
const at = new Date("2026-09-11T00:00:00Z");

describe("completedYearsBetween", () => {
  it("counts whole years on calendar boundaries", () => {
    expect(completedYearsBetween(new Date("2000-09-11T00:00:00Z"), at)).toBe(26);
  });

  it("does not credit a year until the birthday has passed", () => {
    // The day before the birthday is still the previous age. Dividing milliseconds by
    // 365.25 days gets this wrong around leap years, which is why it is computed on
    // calendar fields.
    expect(completedYearsBetween(new Date("2008-09-12T00:00:00Z"), at)).toBe(17);
    expect(completedYearsBetween(new Date("2008-09-11T00:00:00Z"), at)).toBe(18);
  });

  it("handles a 29 February birthday", () => {
    expect(
      completedYearsBetween(new Date("2008-02-29T00:00:00Z"), new Date("2026-02-28T00:00:00Z")),
    ).toBe(17);
    expect(
      completedYearsBetween(new Date("2008-02-29T00:00:00Z"), new Date("2026-03-01T00:00:00Z")),
    ).toBe(18);
  });
});

describe("DERIVED_CLAIMS — the V0 age check", () => {
  const policy: ResultPolicy = {
    kind: "DERIVED_CLAIMS",
    derivations: [
      {
        name: "AgeAtLeast",
        sourcePath: ["birthdate"],
        minimumAgeYears: 18,
        outputClaim: "over_18",
      },
    ],
  };

  it("emits only the boolean and never the date of birth", () => {
    const disclosed: DisclosedClaims = { birthdate: "1990-05-17" };
    const outcome = applyResultPolicy(policy, disclosed, at);

    expect(outcome.satisfied).toBe(true);
    expect(outcome.claims).toEqual({ over_18: true });
    // The critical assertion: the source value is nowhere in the output, under any key.
    expect(JSON.stringify(outcome.claims)).not.toContain("1990");
    expect(Object.keys(outcome.claims)).toEqual(["over_18"]);
  });

  it("returns false for someone under the threshold, still without the date", () => {
    const outcome = applyResultPolicy(policy, { birthdate: "2015-01-01" }, at);
    expect(outcome.claims).toEqual({ over_18: false });
    expect(outcome.satisfied).toBe(true);
  });

  it("is unsatisfied when the source claim was not disclosed", () => {
    const outcome = applyResultPolicy(policy, {}, at);
    expect(outcome.satisfied).toBe(false);
    // The reason names the path, never a value.
    expect(outcome.unsatisfiedReasons[0]).toContain("birthdate");
    expect(outcome.claims).toEqual({});
  });

  it("is unsatisfied when the source claim is not a parsable date", () => {
    const outcome = applyResultPolicy(policy, { birthdate: "not-a-date" }, at);
    expect(outcome.satisfied).toBe(false);
    expect(outcome.unsatisfiedReasons[0]).toContain("not a parsable date");
  });

  it("reads an mdoc namespaced source path", () => {
    const mdocPolicy: ResultPolicy = {
      kind: "DERIVED_CLAIMS",
      derivations: [
        {
          name: "AgeAtLeast",
          sourcePath: ["eu.europa.ec.eudi.pid.1", "birth_date"],
          minimumAgeYears: 18,
          outputClaim: "over_18",
        },
      ],
    };
    const outcome = applyResultPolicy(
      mdocPolicy,
      { "eu.europa.ec.eudi.pid.1": { birth_date: "1980-01-01" } },
      at,
    );
    expect(outcome.claims).toEqual({ over_18: true });
  });
});

describe("DERIVED_CLAIMS — other derivations", () => {
  it("ClaimPresence reports presence without the value", () => {
    const outcome = applyResultPolicy(
      {
        kind: "DERIVED_CLAIMS",
        derivations: [
          { name: "ClaimPresence", sourcePath: ["email"], outputClaim: "has_email" },
        ],
      },
      { email: "person@example.test" },
      at,
    );
    expect(outcome.claims).toEqual({ has_email: true });
    expect(JSON.stringify(outcome.claims)).not.toContain("example.test");
  });

  it("ClaimInSet reports membership without the value", () => {
    const outcome = applyResultPolicy(
      {
        kind: "DERIVED_CLAIMS",
        derivations: [
          {
            name: "ClaimInSet",
            sourcePath: ["issuing_country"],
            allowedValues: ["NL", "PT"],
            outputClaim: "country_allowed",
          },
        ],
      },
      { issuing_country: "NL" },
      at,
    );
    expect(outcome.claims).toEqual({ country_allowed: true });
  });
});

describe("VERIFIED_CLAIMS", () => {
  it("returns only the allowed claims", () => {
    const outcome = applyResultPolicy(
      { kind: "VERIFIED_CLAIMS", allowedClaims: [["given_name"]] },
      { given_name: "Jan", family_name: "'t Hart", birthdate: "1978-02-12" },
      at,
    );
    // `family_name` and `birthdate` were disclosed by the wallet but are not allowed out.
    expect(outcome.claims).toEqual({ given_name: "Jan" });
  });

  it("is unsatisfied when an allowed claim was not disclosed", () => {
    const outcome = applyResultPolicy(
      { kind: "VERIFIED_CLAIMS", allowedClaims: [["given_name"], ["portrait"]] },
      { given_name: "Jan" },
      at,
    );
    expect(outcome.satisfied).toBe(false);
    expect(outcome.claims).toEqual({ given_name: "Jan" });
  });

  it("strips OIA_16 unique elements from a nested allowed claim", () => {
    // `AS-RP-01-002` (`OIA_16`) forbids communicating salts, hashes, the device-binding key
    // or the provider signature to the Relying Party or anyone else — so these must not
    // survive even inside an allowed claim's value.
    const outcome = applyResultPolicy(
      { kind: "VERIFIED_CLAIMS", allowedClaims: [["address"]] },
      {
        address: {
          locality: "Leiden",
          _sd: ["hash-one", "hash-two"],
          salt: "abc",
          cnf: { jwk: { x: "…" } },
        },
      },
      at,
    );
    expect(outcome.claims).toEqual({ address: { locality: "Leiden" } });
    const serialised = JSON.stringify(outcome.claims);
    expect(serialised).not.toContain("_sd");
    expect(serialised).not.toContain("salt");
    expect(serialised).not.toContain("cnf");
  });

  it("returns a frozen claims object so a caller cannot mutate the stored result", () => {
    const outcome = applyResultPolicy(
      { kind: "VERIFIED_CLAIMS", allowedClaims: [["given_name"]] },
      { given_name: "Jan" },
      at,
    );
    expect(Object.isFrozen(outcome.claims)).toBe(true);
  });
});

describe("findResultPolicyViolations", () => {
  it("reports a derivation reading an unrequested claim", () => {
    const violations = findResultPolicyViolations(
      {
        kind: "DERIVED_CLAIMS",
        derivations: [
          {
            name: "AgeAtLeast",
            sourcePath: ["birthdate"],
            minimumAgeYears: 18,
            outputClaim: "over_18",
          },
        ],
      },
      [["given_name"]],
    );
    expect(violations).toContain("birthdate");
  });

  it("reports two derivations writing the same output claim", () => {
    const violations = findResultPolicyViolations(
      {
        kind: "DERIVED_CLAIMS",
        derivations: [
          {
            name: "AgeAtLeast",
            sourcePath: ["birthdate"],
            minimumAgeYears: 18,
            outputClaim: "ok",
          },
          { name: "ClaimPresence", sourcePath: ["birthdate"], outputClaim: "ok" },
        ],
      },
      [["birthdate"]],
    );
    expect(violations.some((v) => v.includes("duplicate output claim"))).toBe(true);
  });
});
