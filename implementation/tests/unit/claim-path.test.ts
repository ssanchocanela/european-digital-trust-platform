import type { ClaimPath } from "@edtp/domain";
import {
  claimPathCovers,
  claimPathEquals,
  dedupeRequestedClaims,
  findClaimPathViolations,
  formatClaimPath,
  isValidClaimPath,
  readClaimAtPath,
} from "@edtp/domain";
import { describe, expect, it } from "vitest";

/**
 * Claim-path subset semantics.
 *
 * ADR 0005 Decision 1c calls this the most error-prone detail in the policy layer, and the
 * failure mode is silent: a flat string comparison would both over-accept (a nested claim
 * under a registered parent) and under-accept (a correctly nested path). These tests pin
 * the rules from ADR 0005 Decision 2.
 */
describe("claim path validation", () => {
  it("accepts paths of strings, nulls and non-negative integers", () => {
    expect(isValidClaimPath(["birthdate"])).toBe(true);
    expect(isValidClaimPath(["eu.europa.ec.eudi.pid.1", "birth_date"])).toBe(true);
    expect(isValidClaimPath(["nationalities", null])).toBe(true);
    expect(isValidClaimPath(["nationalities", 0])).toBe(true);
  });

  it("rejects empty paths, empty segments, negative and fractional indices", () => {
    expect(isValidClaimPath([])).toBe(false);
    expect(isValidClaimPath([""])).toBe(false);
    expect(isValidClaimPath(["a", -1])).toBe(false);
    expect(isValidClaimPath(["a", 1.5])).toBe(false);
    expect(isValidClaimPath("birthdate")).toBe(false);
    expect(isValidClaimPath([{ a: 1 }])).toBe(false);
  });

  it("renders a stable, readable form for errors and audit records", () => {
    expect(formatClaimPath(["address", "street_address"])).toBe("address.street_address");
    expect(formatClaimPath(["nationalities", null])).toBe("nationalities.*");
    expect(formatClaimPath(["nationalities", 0])).toBe("nationalities.[0]");
  });
});

describe("claimPathCovers", () => {
  const covers = (registered: ClaimPath, requested: ClaimPath) =>
    claimPathCovers(registered, requested);

  it("accepts an identical path", () => {
    expect(covers(["birthdate"], ["birthdate"])).toBe(true);
  });

  it("accepts a requested path that extends a registered path", () => {
    // A registered `address` is the broader disclosure, so a narrower nested claim is
    // within it.
    expect(covers(["address"], ["address", "locality"])).toBe(true);
    expect(covers(["address"], ["address", "street_address"])).toBe(true);
  });

  it("refuses a requested path that is a strict prefix of a registered path", () => {
    // Requesting `address` when only `address.locality` was registered asks for more.
    expect(covers(["address", "locality"], ["address"])).toBe(false);
  });

  it("refuses a sibling path", () => {
    expect(covers(["address", "locality"], ["address", "postal_code"])).toBe(false);
  });

  it("treats a registered null as a wildcard over array elements", () => {
    // A registered wildcard covers all elements, so a specific index is narrower.
    expect(covers(["nationalities", null], ["nationalities", 0])).toBe(true);
    expect(covers(["nationalities", null], ["nationalities", null])).toBe(true);
  });

  it("refuses a requested wildcard where only one index was registered", () => {
    // Requesting every element when only element 0 was registered asks for more.
    expect(covers(["nationalities", 0], ["nationalities", null])).toBe(false);
  });

  it("compares indices structurally, not as strings", () => {
    // A string "0" is an object member name; the integer 0 is an array index. Conflating
    // them would let a path through on a different credential shape.
    expect(covers(["a", 0], ["a", "0"])).toBe(false);
    expect(covers(["a", "0"], ["a", 0])).toBe(false);
  });

  it("distinguishes mdoc namespaces", () => {
    // For mdoc the first segment is the namespace. A flat model would lose it and let a
    // claim from another namespace through.
    expect(
      covers(
        ["eu.europa.ec.eudi.pid.1", "birth_date"],
        ["eu.europa.ec.eudi.pid.1", "birth_date"],
      ),
    ).toBe(true);
    expect(
      covers(["eu.europa.ec.eudi.pid.1", "birth_date"], ["org.iso.18013.5.1", "birth_date"]),
    ).toBe(false);
  });
});

describe("findClaimPathViolations", () => {
  const registered: ClaimPath[] = [["birthdate"], ["address"]];

  it("returns nothing when every requested claim is within the registered set", () => {
    const violations = findClaimPathViolations(
      [{ path: ["birthdate"] }, { path: ["address", "locality"] }],
      registered,
    );
    expect(violations).toHaveLength(0);
  });

  it("reports every violation, not just the first", () => {
    const violations = findClaimPathViolations(
      [
        { path: ["birthdate"] },
        { path: ["portrait"] },
        { path: ["personal_administrative_number"] },
      ],
      registered,
    );
    expect(violations).toHaveLength(2);
    expect(violations.map((v) => formatClaimPath(v.requested))).toEqual([
      "portrait",
      "personal_administrative_number",
    ]);
  });
});

describe("dedupeRequestedClaims", () => {
  it("removes structurally identical paths and preserves order", () => {
    const deduped = dedupeRequestedClaims([
      { path: ["birthdate"] },
      { path: ["address", "locality"] },
      { path: ["birthdate"] },
    ]);
    expect(deduped.map((c) => formatClaimPath(c.path))).toEqual([
      "birthdate",
      "address.locality",
    ]);
  });
});

describe("claimPathEquals", () => {
  it("distinguishes null from undefined-length differences", () => {
    expect(claimPathEquals(["a", null], ["a", null])).toBe(true);
    expect(claimPathEquals(["a", null], ["a"])).toBe(false);
  });
});

describe("readClaimAtPath", () => {
  const disclosed = {
    birthdate: "1990-05-17",
    address: { locality: "Leiden", street_address: "Rietveld 1" },
    nationalities: ["NL", "PT"],
  };

  it("reads a top-level member", () => {
    expect(readClaimAtPath(disclosed, ["birthdate"])).toBe("1990-05-17");
  });

  it("reads a nested member", () => {
    expect(readClaimAtPath(disclosed, ["address", "locality"])).toBe("Leiden");
  });

  it("reads an array element by index and the whole array by wildcard", () => {
    expect(readClaimAtPath(disclosed, ["nationalities", 0])).toBe("NL");
    expect(readClaimAtPath(disclosed, ["nationalities", null])).toEqual(["NL", "PT"]);
  });

  it("returns undefined for an absent claim rather than throwing", () => {
    // An absent optional claim is a normal outcome, and the result policy turns it into
    // POLICY_NOT_SATISFIED rather than an error.
    expect(readClaimAtPath(disclosed, ["portrait"])).toBeUndefined();
    expect(readClaimAtPath(disclosed, ["address", "country"])).toBeUndefined();
    expect(readClaimAtPath(disclosed, ["birthdate", "nested"])).toBeUndefined();
  });
});
