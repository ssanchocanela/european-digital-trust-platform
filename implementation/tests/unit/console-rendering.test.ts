/**
 * The console's escaping and its privacy boundary.
 *
 * Two things are worth a test rather than a comment. The console renders text a *customer* supplied —
 * a policy's purpose, a trade name, a business reference — so escaping is not theoretical. And the
 * result panel is where `AS-RP-01-002` (`OIA_16`) meets a web page: a panel that rendered anything the
 * API did not return would be the leak `CLAUDE.md` §5 forbids, and the easiest place to introduce one.
 */
import { escapeHtml, html, rawHtml, toHtmlString } from "@edtp/operator-console/html.js";
import { InteractionCache } from "@edtp/operator-console/interaction-cache.js";
import {
  issuanceOffersView,
  issuancePolicyView,
  newIssuanceView,
} from "@edtp/operator-console/issuance-views.js";
import {
  errorCodeOf,
  errorMessageOf,
  type PolicyOption,
} from "@edtp/operator-console/platform-client.js";
import { statusPayload, testDriverView } from "@edtp/operator-console/views.js";
import { describe, expect, it } from "vitest";

describe("escaping", () => {
  it("escapes the five characters that matter in content and in quoted attributes", () => {
    expect(escapeHtml(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&#39;");
  });

  it("escapes interpolations by default", () => {
    const injected = '"><script>alert(1)</script>';
    const out = toHtmlString(html`<p title="${injected}">${injected}</p>`);
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("leaves already-safe markup alone, and only via rawHtml", () => {
    // `rawHtml(` is the single searchable escape hatch. If this test ever needs changing, the change
    // under review is "something new is being trusted".
    const out = toHtmlString(html`<div>${rawHtml("<b>bold</b>")}</div>`);
    expect(out).toBe("<div><b>bold</b></div>");
  });

  it("renders arrays and drops nullish values rather than printing them", () => {
    expect(toHtmlString(html`${[1, 2, 3]}`)).toBe("123");
    expect(toHtmlString(html`${null}${undefined}${false}`)).toBe("");
  });
});

describe("the status payload the poller consumes", () => {
  const base = {
    presentationId: "p-1",
    businessReference: "run-1",
    policyId: "pol-1",
    policyVersion: 2,
    expiresAt: "2026-09-11T12:00:00.000Z",
  };

  it("adds nothing the API did not return", () => {
    const payload = statusPayload({ ...base, status: "PENDING" });
    expect(Object.keys(payload).sort()).toEqual(
      ["failureCode", "resultHtml", "status", "terminal"].sort(),
    );
  });

  it("marks terminal states so the poller stops", () => {
    expect(statusPayload({ ...base, status: "VERIFIED" })["terminal"]).toBe(true);
    expect(statusPayload({ ...base, status: "FAILED" })["terminal"]).toBe(true);
    expect(statusPayload({ ...base, status: "PENDING" })["terminal"]).toBe(false);
  });

  it("escapes claim keys and values, which are attacker-influenced in the general case", () => {
    const payload = statusPayload({
      ...base,
      status: "VERIFIED",
      result: { claims: { "<img src=x onerror=alert(1)>": '"><script>alert(1)</script>' } },
    });
    const markup = String(payload["resultHtml"]);
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("<img");
    expect(markup).toContain("&lt;img");
  });

  it("summarises a structured claim rather than dumping it", () => {
    // A claim whose value is an object or array is reported by shape. Stringifying an object graph is
    // how a nested value nobody expected ends up on a screen and then in a screenshot.
    const payload = statusPayload({
      ...base,
      status: "VERIFIED",
      result: { claims: { address: { street: "x" }, names: ["a", "b"] } },
    });
    const markup = String(payload["resultHtml"]);
    expect(markup).toContain("{object}");
    expect(markup).toContain("[2 values]");
    expect(markup).not.toContain("street");
  });

  it("shows no result panel content when there is no result", () => {
    const markup = String(statusPayload({ ...base, status: "PENDING" })["resultHtml"]);
    expect(markup).toContain("No result yet");
  });
});

describe("the interaction cache", () => {
  // It exists because `GET /v1/presentations/{id}` does not return the interaction URI. It is the one
  // piece of state the console holds, so its bounds are worth asserting rather than trusting.
  it("returns what was stored, until it expires", () => {
    let now = 0;
    const cache = new InteractionCache(() => now);
    cache.set("p-1", { uri: "openid4vp://?a=1", type: "SAME_DEVICE" });

    expect(cache.get("p-1")?.uri).toBe("openid4vp://?a=1");
    now = 10 * 60 * 1_000 - 1;
    expect(cache.get("p-1")).toBeDefined();
    now = 10 * 60 * 1_000;
    expect(cache.get("p-1")).toBeUndefined();
  });

  it("is bounded, so a loop creating presentations cannot grow it without limit", () => {
    const cache = new InteractionCache(() => 0);
    for (let i = 0; i < 500; i += 1) {
      cache.set(`p-${i}`, { uri: `openid4vp://?i=${i}`, type: "QR" });
    }
    expect(cache.size).toBeLessThanOrEqual(200);
    // Oldest-first eviction: the most recent entry must survive, because that is the one a redirect is
    // about to render.
    expect(cache.get("p-499")).toBeDefined();
  });

  it("does not resurrect an expired entry", () => {
    let now = 0;
    const cache = new InteractionCache(() => now);
    cache.set("p-1", { uri: "openid4vp://?a=1", type: "QR" });
    now = 11 * 60 * 1_000;
    expect(cache.get("p-1")).toBeUndefined();
    expect(cache.size).toBe(0);
  });
});

describe("the policy picker", () => {
  /**
   * The picker exists because of a specific hour lost on 13 September 2026: two policies whose names
   * differ by a suffix belong to Relying Party Services whose instances hold different access
   * certificates, and the wallet's refusal says only that the relying party could not be verified.
   *
   * So these tests are not about a `<select>` rendering. They pin the three properties that make the
   * list safer than the text box it replaced, each of which is easy to lose in a later tidy-up.
   */
  const option = (over: Partial<PolicyOption> = {}): PolicyOption => ({
    id: "30627f9a-3e6b-4d56-89ed-3e9b1e0af801",
    name: "Adult verification",
    relyingPartyServiceName: "Smoke Test Age Gate",
    publishedVersion: 1,
    status: "ACTIVE",
    ...over,
  });

  const render = (options: Parameters<typeof testDriverView>[0]) =>
    toHtmlString(testDriverView(options));

  it("names the Relying Party Service beside every policy", () => {
    // The whole point. Two near-identical names are told apart only by their Service.
    const out = render({
      sameDeviceAvailable: true,
      policies: [
        option(),
        option({
          id: "f7013836-7656-402b-9745-b762acfea774",
          name: "Adult verification (WD-3)",
          relyingPartyServiceName: "EDTP EUDI Gate (WD-3)",
        }),
      ],
    });
    expect(out).toContain("Adult verification — Smoke Test Age Gate");
    expect(out).toContain("Adult verification (WD-3) — EDTP EUDI Gate (WD-3)");
  });

  it("disables a policy that cannot start a transaction, and says why", () => {
    // Offering it would produce `no_published_policy_version` at submit — the same lesson, learned
    // later and less clearly. Hiding it would leave someone hunting for a policy they know exists.
    const out = render({
      sameDeviceAvailable: true,
      policies: [option({ publishedVersion: null }), option({ id: "b", status: "RETIRED" })],
    });
    expect(out).toContain("(no published version)");
    expect(out).toContain("(retired)");
    expect(out.match(/ disabled/g)?.length).toBe(3); // two policies plus the placeholder
  });

  it("falls back to the text box when the list could not be read, and says so", () => {
    // A screen that cannot start a presentation because a *list* call failed would be worse than the
    // screen that never had a list.
    const out = render({ sameDeviceAvailable: true, policiesError: "engine_unreachable" });
    expect(out).toContain('<input type="text" name="policyId"');
    expect(out).toContain("engine_unreachable");
    // Not "no <select> on the page" — the interaction type is one. The policy field specifically.
    expect(out).not.toContain('<select name="policyId"');
  });

  it("escapes a Service name, which is customer-supplied text", () => {
    const out = render({
      sameDeviceAvailable: true,
      policies: [option({ relyingPartyServiceName: '"><script>alert(1)</script>' })],
    });
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("says when more policies exist than are listed", () => {
    // Silently showing the first page of many is how someone concludes a policy was deleted.
    const out = render({
      sameDeviceAvailable: true,
      policies: [option()],
      policiesTruncated: true,
    });
    expect(out).toContain("More policies exist");
  });
});

describe("the platform's error envelope", () => {
  /**
   * The envelope is flat — `{ error: "<code>", message: "…" }` — and the client used to look for
   * `{ error: { code, message } }`. It found a string where it expected an object, returned nothing,
   * and every platform error the console showed fell back to the HTTP status line with the code
   * `platform_api_error`.
   *
   * Nothing failed. The fallback read like a reasonable message, which is why it survived: the same
   * shape as `interop-findings.md` A18 and A24, and found the same way — by looking at what the API
   * actually sends.
   */
  it("reads the code and the message the platform actually sends", () => {
    const body = JSON.stringify({
      error: "attestation_provider_not_provisioned",
      message: "The Attestation Provider has no engine tenant yet.",
      correlationId: "c-1",
    });
    expect(errorCodeOf(body)).toBe("attestation_provider_not_provisioned");
    expect(errorMessageOf(body, { status: 409, statusText: "Conflict" } as Response)).toBe(
      "The Attestation Provider has no engine tenant yet.",
    );
  });

  it("falls back to the status line only when there is nothing to read", () => {
    expect(
      errorMessageOf("not json", { status: 502, statusText: "Bad Gateway" } as Response),
    ).toBe("The platform API answered 502 Bad Gateway.");
    expect(errorCodeOf("not json")).toBe("platform_api_error");
  });

  it("still reads a nested envelope, in case one is ever sent", () => {
    const nested = JSON.stringify({ error: { code: "x", message: "y" } });
    expect(errorCodeOf(nested)).toBe("x");
  });
});

describe("the issuance builder", () => {
  const providers = [{ id: "11111111-1111-1111-1111-111111111111", name: "Acme Issuer BV" }];

  it("offers only the evaluators and connectors the platform reports", () => {
    // They are registered at startup and resolved then, so a name this form invented would be
    // refused at publication, after the operator had filled in five fieldsets. The console has no
    // privileged view and no hard-coded list: it renders what the API returned.
    const out = toHtmlString(
      newIssuanceView({
        providers,
        evaluators: ["AlwaysEligible", "MinimumAge"],
        connectors: [
          {
            name: "fixture",
            kind: "FIXTURE",
            sampleSubjectReferences: ["fixture-subject-adult"],
          },
        ],
      }),
    );

    expect(out).toContain(">AlwaysEligible<");
    expect(out).toContain(">MinimumAge<");
    expect(out).toContain('value="fixture"');
    expect(out).toContain("test data");
    // Nothing that exists in the domain but is not registered in this deployment.
    expect(out).not.toContain(">ManualReview<");
  });

  it("says outright that a fixture-only deployment issues test data", () => {
    // The V0 plan §7.2 requires the connector to be labelled a fixture in its own name. The name
    // alone tells an operator nothing about the consequence, so the screen states it where the
    // choice is made.
    const out = toHtmlString(
      newIssuanceView({
        providers,
        evaluators: ["AlwaysEligible"],
        connectors: [
          {
            name: "fixture",
            kind: "FIXTURE",
            sampleSubjectReferences: ["fixture-subject-adult"],
          },
        ],
      }),
    );
    expect(out).toContain("only authentic source available is a fixture");
    expect(out).toContain("test data");
  });

  it("drops the fixture warning when a real connector is registered", () => {
    // Otherwise it becomes decoration, and a warning that is always there is a warning nobody reads.
    const out = toHtmlString(
      newIssuanceView({
        providers,
        evaluators: ["AlwaysEligible"],
        connectors: [
          {
            name: "fixture",
            kind: "FIXTURE",
            sampleSubjectReferences: ["fixture-subject-adult"],
          },
          { name: "hr-system", kind: "REAL" },
        ],
      }),
    );
    expect(out).not.toContain("only authentic source available is a fixture");
  });

  it("refuses to pretend there is something to issue under when there is no provider", () => {
    const out = toHtmlString(
      newIssuanceView({
        providers: [],
        evaluators: ["AlwaysEligible"],
        connectors: [
          {
            name: "fixture",
            kind: "FIXTURE",
            sampleSubjectReferences: ["fixture-subject-adult"],
          },
        ],
      }),
    );
    expect(out).toContain("no Attestation Provider");
    // No form at all: submitting one would fail on a field the operator cannot fill in here.
    expect(out).not.toContain('action="/issuance/new"');
  });

  it("gives back what the operator typed when the form is redisplayed", () => {
    // A form with five fieldsets that empties itself on an error is a form nobody fills in twice.
    const out = toHtmlString(
      newIssuanceView({
        providers,
        evaluators: ["AlwaysEligible"],
        connectors: [
          {
            name: "fixture",
            kind: "FIXTURE",
            sampleSubjectReferences: ["fixture-subject-adult"],
          },
        ],
        error: "Give the credential at least one attribute.",
        submitted: { name: "Company representative", validityDays: "180", format: "mso_mdoc" },
      }),
    );

    expect(out).toContain('value="Company representative"');
    expect(out).toContain('value="180"');
    expect(out).toContain('<option value="mso_mdoc" selected>');
  });

  it("escapes what the operator typed, because it comes straight back into the page", () => {
    const out = toHtmlString(
      newIssuanceView({
        providers,
        evaluators: ["AlwaysEligible"],
        connectors: [
          {
            name: "fixture",
            kind: "FIXTURE",
            sampleSubjectReferences: ["fixture-subject-adult"],
          },
        ],
        submitted: { name: '"><script>alert(1)</script>' },
      }),
    );
    expect(out).not.toContain("<script>alert(1)");
    expect(out).toContain("&lt;script&gt;");
  });
});

describe("what a created credential offer is read from", () => {
  it("renders the offer when the route's own field name is used", () => {
    // `POST /v1/issuances` answers with `interaction: {type, uri}`. The console read `offer`, a
    // field that route has never sent, so `created.offer` was always undefined and every offer
    // rendered as "No offer open" — the QR this screen is built around had never been displayed.
    // The seventh shape on this project assumed rather than read.
    const withOffer = toHtmlString(
      issuancePolicyView({
        policy: {
          id: "p1",
          name: "Company representative",
          credentialTypeName: "Company representative",
          credentialFormat: "dc+sd-jwt",
          publishedVersion: 1,
          status: "ACTIVE",
        },
        issuances: [],
        offer: {
          uri: "openid-credential-offer://?credential_offer_uri=https%3A%2F%2Fexample.test%2Fo%2F1",
          issuanceId: "i1",
          expiresAt: "2026-09-16T12:00:00.000Z",
        },
        qr: rawHtml("<svg></svg>"),
      }),
    );
    expect(withOffer).toContain("Scan with the wallet");
    expect(withOffer).toContain("<svg>");
    expect(withOffer).not.toContain("No offer open");

    const withoutOffer = toHtmlString(
      issuancePolicyView({
        policy: {
          id: "p1",
          name: "Company representative",
          credentialTypeName: "Company representative",
          credentialFormat: "dc+sd-jwt",
          publishedVersion: 1,
          status: "ACTIVE",
        },
        issuances: [],
      }),
    );
    expect(withoutOffer).toContain("No offer open");
  });
});

describe("retired policies on the issuance list", () => {
  const policy = (name: string, status: string) => ({
    id: `id-${name}`,
    name,
    credentialTypeName: "Badge",
    credentialFormat: "dc+sd-jwt",
    publishedVersion: 1,
    status,
    issuances: 0,
  });

  it("keeps retired policies out of the working list without hiding them", () => {
    // Deleting is not offered and should not be: attestations reference the policy version they
    // were issued under, and a list that pretended the policy never existed would make those
    // unexplainable. Retirement is the honest middle.
    const out = toHtmlString(
      issuanceOffersView({
        policies: [policy("Live badge", "ACTIVE"), policy("Old badge", "RETIRED")],
      }),
    );

    expect(out).toContain("Live badge");
    expect(out).toContain("Old badge");
    expect(out).toContain("<h2>Retired</h2>");
    // The retired one appears after the heading that explains it, not mixed into the live table.
    expect(out.indexOf("Old badge")).toBeGreaterThan(out.indexOf("<h2>Retired</h2>"));
    expect(out.indexOf("Live badge")).toBeLessThan(out.indexOf("<h2>Retired</h2>"));
  });

  it("shows no retired section when nothing is retired", () => {
    const out = toHtmlString(issuanceOffersView({ policies: [policy("Only", "ACTIVE")] }));
    expect(out).not.toContain("<h2>Retired</h2>");
  });

  it("does not offer to retire a policy that already is", () => {
    const retired = toHtmlString(
      issuancePolicyView({
        policy: {
          id: "p1",
          name: "Old badge",
          credentialTypeName: "Badge",
          credentialFormat: "dc+sd-jwt",
          publishedVersion: 1,
          status: "RETIRED",
        },
        issuances: [],
      }),
    );
    expect(retired).toContain("This policy is retired");
    expect(retired).toContain("Bring it back");
    expect(retired).not.toContain("<h2>Retire this policy</h2>");

    const active = toHtmlString(
      issuancePolicyView({
        policy: {
          id: "p1",
          name: "Live badge",
          credentialTypeName: "Badge",
          credentialFormat: "dc+sd-jwt",
          publishedVersion: 1,
          status: "ACTIVE",
        },
        issuances: [],
      }),
    );
    expect(active).toContain("<h2>Retire this policy</h2>");
    expect(active).not.toContain("Bring it back");
  });
});

describe("the offer form's subject reference", () => {
  const policy = {
    id: "p1",
    name: "Employee badge issuance",
    credentialTypeName: "Employee badge",
    credentialFormat: "dc+sd-jwt",
    publishedVersion: 1,
    status: "ACTIVE",
  };

  it("pre-fills a real value rather than a placeholder that looks like one", () => {
    // A grey placeholder inside an empty box reads as filled in. It was submitted empty, answered
    // "Subject at the authentic source was not found", and cost a demonstration several attempts.
    const out = toHtmlString(
      issuancePolicyView({
        policy,
        issuances: [],
        knownSubjects: ["fixture-subject-adult", "fixture-subject-minor"],
      }),
    );
    expect(out).toContain('value="fixture-subject-adult"');
    expect(out).not.toContain('placeholder="fixture-subject-adult"');
    expect(out).toContain('<option value="fixture-subject-minor">');
  });

  it("offers no list when the source is not a fixture", () => {
    const out = toHtmlString(issuancePolicyView({ policy, issuances: [] }));
    expect(out).not.toContain("<datalist");
    expect(out).not.toContain("answers for these and nothing else");
  });
});
