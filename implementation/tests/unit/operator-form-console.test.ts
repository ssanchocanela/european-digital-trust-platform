import { toHtmlString } from "@edtp/operator-console/html.js";
import { operatorFormFields, readOperatorForm } from "@edtp/operator-console/issuance-views.js";
import type { OperatorForm } from "@edtp/operator-console/platform-client.js";
import { describe, expect, it } from "vitest";

/**
 * The console's form for an `operator-form` policy — the one screen where a person's details could
 * be typed into a credential. What is pinned: the warning is always there, fixed claims are shown
 * but not offered as inputs, and what the operator types becomes `subjectAttributes` in the shape
 * the API takes, with blanks omitted.
 */

const FORM: OperatorForm = {
  fields: [
    { path: "family_name", label: "Family name", valueType: "string", mandatory: true },
    { path: "birthdate", label: "Date of birth", valueType: "date", mandatory: true },
    {
      path: "place_of_birth.locality",
      label: "Place of birth",
      valueType: "string",
      mandatory: false,
    },
    { path: "nationalities", label: "Nationalities", valueType: "string[]", mandatory: true },
  ],
  fixed: [{ label: "Issuing country", value: "ES" }],
};

describe("operatorFormFields", () => {
  const page = toHtmlString(operatorFormFields(FORM));

  it("warns that only synthetic data may be entered", () => {
    expect(page).toContain("Synthetic test data only");
    expect(page).toContain("Never enter a real");
  });

  it("renders one input per field, typed and required as declared", () => {
    expect(page).toMatch(/type="text" name="attr:family_name" required/);
    expect(page).toMatch(/type="date" name="attr:birthdate" required/);
    expect(page).not.toMatch(/name="attr:place_of_birth.locality" required/);
    expect(page).toContain("(optional)");
  });

  it("shows fixed claims read-only rather than as inputs", () => {
    expect(page).toContain("Issuing country <code>ES</code>");
    expect(page).not.toContain('name="attr:issuing_country"');
  });

  it("escapes a label", () => {
    const hostile = toHtmlString(
      operatorFormFields({
        fields: [{ path: "x", label: "<script>", valueType: "string", mandatory: true }],
        fixed: [],
      }),
    );
    expect(hostile).not.toContain("<script>");
  });
});

describe("readOperatorForm", () => {
  it("builds subjectAttributes in the API's dotted shape, omitting blanks", () => {
    expect(
      readOperatorForm(FORM, {
        "attr:family_name": "  TEST ",
        "attr:birthdate": "1990-01-01",
        "attr:place_of_birth.locality": "",
        "attr:nationalities": "es, pt",
      }),
    ).toEqual({ family_name: "TEST", birthdate: "1990-01-01", nationalities: ["ES", "PT"] });
  });

  it("ignores anything posted that the form does not declare", () => {
    expect(readOperatorForm(FORM, { "attr:issuing_country": "FR", other: "x" })).toEqual({});
  });
});
