import { applyResultPolicy, findResultPolicyViolations, type ResultPolicy } from "@edtp/domain";
import { isDeniedKey } from "@edtp/shared";
import { describe, expect, it } from "vitest";

/**
 * `PseudonymousSubject` (ADR 0015 Decision 4): an HMAC over several claims, per tenant key, that
 * lets the sandbox recognise a returning person without keeping any PID value.
 */
const policy: ResultPolicy = {
  kind: "DERIVED_CLAIMS",
  derivations: [
    {
      name: "PseudonymousSubject",
      sourcePaths: [["given_name"], ["family_name"], ["birthdate"], ["issuing_country"]],
      outputClaim: "subject",
    },
  ],
};
const at = new Date("2026-11-12T00:00:00Z");
const key = Buffer.alloc(32, 7);
const person = {
  given_name: "Ana",
  family_name: "Pérez García",
  birthdate: "1990-04-01",
  issuing_country: "ES",
};

describe("PseudonymousSubject", () => {
  it("returns only the subject, never a source value", () => {
    const outcome = applyResultPolicy(policy, person, at, { pseudonymKey: key });
    expect(outcome.satisfied).toBe(true);
    expect(Object.keys(outcome.claims)).toEqual(["subject"]);
    const serialised = JSON.stringify(outcome.claims);
    for (const value of Object.values(person)) expect(serialised).not.toContain(value);
    expect(outcome.claims.subject).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("is stable across normalisation differences: case, spacing, Unicode form", () => {
    const a = applyResultPolicy(policy, person, at, { pseudonymKey: key }).claims.subject;
    const b = applyResultPolicy(
      policy,
      { ...person, given_name: " ana ", family_name: "PÉREZ  GARCÍA" },
      at,
      { pseudonymKey: key },
    ).claims.subject;
    expect(b).toBe(a);
  });

  it("differs for a different person, and under a different key (another tenant)", () => {
    const a = applyResultPolicy(policy, person, at, { pseudonymKey: key }).claims.subject;
    const other = applyResultPolicy(policy, { ...person, birthdate: "1990-04-02" }, at, {
      pseudonymKey: key,
    });
    const otherTenant = applyResultPolicy(policy, person, at, {
      pseudonymKey: Buffer.alloc(32, 8),
    });
    expect(other.claims.subject).not.toBe(a);
    expect(otherTenant.claims.subject).not.toBe(a);
  });

  it("does not let values run together: [ab, c] and [a, bc] differ", () => {
    const two: ResultPolicy = {
      kind: "DERIVED_CLAIMS",
      derivations: [
        { name: "PseudonymousSubject", sourcePaths: [["x"], ["y"]], outputClaim: "s" },
      ],
    };
    const left = applyResultPolicy(two, { x: "ab", y: "c" }, at, { pseudonymKey: key }).claims
      .s;
    const right = applyResultPolicy(two, { x: "a", y: "bc" }, at, { pseudonymKey: key }).claims
      .s;
    expect(left).not.toBe(right);
  });

  it("is unsatisfied without a key, or when a source claim is missing or structured", () => {
    expect(applyResultPolicy(policy, person, at).satisfied).toBe(false);
    const { birthdate: _omitted, ...missing } = person;
    expect(applyResultPolicy(policy, missing, at, { pseudonymKey: key }).satisfied).toBe(false);
    const structured = applyResultPolicy(policy, { ...person, given_name: { a: 1 } }, at, {
      pseudonymKey: key,
    });
    expect(structured.satisfied).toBe(false);
    expect(structured.unsatisfiedReasons.join(" ")).not.toContain("Ana");
  });

  it("is validated against the requested claims like any derivation", () => {
    expect(
      findResultPolicyViolations(policy, [["given_name"], ["family_name"], ["birthdate"]]),
    ).toEqual(["issuing_country"]);
  });

  it("keeps the master key off the logs", () => {
    expect(isDeniedKey("PSEUDONYM_MASTER_KEY")).toBe(true);
  });
});
