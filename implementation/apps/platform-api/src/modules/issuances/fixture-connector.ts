import type {
  AuthenticSourceConnector,
  EligibilityDecision,
  EligibilityEvaluator,
  SourceAttributes,
} from "@edtp/domain";
import { completedYearsBetween } from "@edtp/domain";

/**
 * A **fixture** authentic source. Not a real one, and it says so.
 *
 * §7.2 of the V0 plan asks for "a fixture/mock connector clearly labelled as such". The labelling
 * is structural rather than a comment: `kind` is `"FIXTURE"`, that value is written to the issuance
 * transaction, carried into the audit record, and returned to the caller as a warning. So an
 * attestation issued from this data cannot be mistaken for one issued from a real source at any
 * point — including by someone reading the database months later.
 *
 * The fixtures are deliberately boring and obviously synthetic. No realistic-looking personal data,
 * because a realistic fixture is the kind of thing that eventually gets mistaken for real.
 */
export class FixtureAuthenticSourceConnector implements AuthenticSourceConnector {
  readonly name = "fixture";
  readonly kind = "FIXTURE" as const;

  /**
   * Subjects this connector knows about.
   *
   * Keyed by the `subjectReference` a business client supplies. An unknown reference returns
   * `undefined`, which the service turns into a 404 — the same answer a real source would give,
   * so the flow is exercised rather than short-circuited.
   */
  private readonly subjects: ReadonlyMap<string, SourceAttributes> = new Map<
    string,
    SourceAttributes
  >([
    [
      "fixture-subject-adult",
      {
        given_name: "TEST",
        family_name: "FIXTURE-ADULT",
        birthdate: "1990-01-01",
        employee_id: "FIXTURE-0001",
        employer_name: "Fixture Employer BV",
        // Returned but not declared by the V0 credential type, so `narrowToDeclaredClaims` drops
        // it. Present on purpose: it proves the narrowing actually happens rather than being
        // trusted, and a real source returning surplus attributes is the common case.
        internal_hr_notes: "SHOULD BE DROPPED BY NARROWING",
      },
    ],
    [
      "fixture-subject-minor",
      {
        given_name: "TEST",
        family_name: "FIXTURE-MINOR",
        birthdate: "2015-06-15",
        employee_id: "FIXTURE-0002",
        employer_name: "Fixture Employer BV",
      },
    ],
    [
      "fixture-subject-incomplete",
      {
        // Missing `employee_id`, which the V0 type declares mandatory. Exists so the refusal path
        // is testable: an attestation that omits a mandatory claim must not be issued.
        given_name: "TEST",
        family_name: "FIXTURE-INCOMPLETE",
        birthdate: "1985-03-03",
        employer_name: "Fixture Employer BV",
      },
    ],
    [
      "fixture-subject-wrong-type",
      {
        given_name: "TEST",
        family_name: "FIXTURE-WRONGTYPE",
        // A date where the type declares `date`, but in a locale format a real source might use.
        birthdate: "03/03/1985",
        employee_id: "FIXTURE-0003",
        employer_name: "Fixture Employer BV",
      },
    ],
  ]);

  async fetch(input: {
    readonly subjectReference: string;
    readonly requestedClaimPaths: readonly string[];
    readonly parameters: Readonly<Record<string, unknown>>;
  }): Promise<SourceAttributes | undefined> {
    return this.subjects.get(input.subjectReference);
  }
}

/**
 * Eligibility by minimum age, computed from a date of birth the source supplied.
 *
 * A named implementation registered at startup — not an expression language. The V0 plan asks for
 * "a small explicit interface", and the reason is that this decides whether a person receives an
 * attestation about themselves: it belongs in reviewed code, not in a string in a database.
 *
 * Note what it does **not** do: it does not return the date of birth, or the computed age, in its
 * reason. The reason is returned to a business client, and "the subject is under 18" discloses
 * materially less than "the subject is 14".
 */
export class MinimumAgeEligibilityEvaluator implements EligibilityEvaluator {
  readonly name = "MinimumAge";

  evaluate(input: {
    readonly attributes: SourceAttributes;
    readonly parameters: Readonly<Record<string, unknown>>;
    readonly at: Date;
  }): EligibilityDecision {
    const minimumAge = input.parameters.minimumAgeYears;
    if (typeof minimumAge !== "number" || !Number.isInteger(minimumAge) || minimumAge < 0) {
      return {
        eligible: false,
        reason:
          "The eligibility rule is misconfigured: minimumAgeYears must be a whole number.",
      };
    }

    const sourcePath =
      typeof input.parameters.sourcePath === "string"
        ? input.parameters.sourcePath
        : "birthdate";
    const raw = input.attributes[sourcePath];
    if (typeof raw !== "string") {
      return {
        eligible: false,
        reason: "The authentic source supplied no usable date of birth.",
      };
    }

    const birthDate = new Date(raw);
    if (Number.isNaN(birthDate.getTime())) {
      return {
        eligible: false,
        reason: "The authentic source supplied an unparsable date of birth.",
      };
    }

    // Reuses the verification side's year arithmetic rather than a second implementation, so the
    // two cannot disagree about what "completed years" means at a leap-day boundary.
    const years = completedYearsBetween(birthDate, input.at);
    return years >= minimumAge
      ? { eligible: true }
      : {
          eligible: false,
          reason: `The subject does not meet the minimum age of ${minimumAge}.`,
        };
  }
}

/** Always eligible. For a credential type whose issuance has no eligibility condition. */
export class AlwaysEligibleEvaluator implements EligibilityEvaluator {
  readonly name = "AlwaysEligible";
  evaluate(): EligibilityDecision {
    return { eligible: true };
  }
}
