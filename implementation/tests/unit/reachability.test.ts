/**
 * Whether a phone could complete an interaction we are about to display.
 *
 * Written after the console rendered a perfectly valid QR carrying `http://localhost:3201/…` and a
 * request object at `http://eudiplo:3000/…`. The operator scanned it, the wallet failed, and there was
 * nothing to distinguish "the configuration cannot work" from "the wallet is broken" — which is the
 * confusion the test driver exists to remove.
 */
import {
  checkInteractionReachability,
  requestUriOf,
} from "@edtp/operator-console/reachability.js";
import { describe, expect, it } from "vitest";

const uriWith = (requestUri: string) =>
  `openid4vp://?client_id=x509_hash%3Aabc&request_uri=${encodeURIComponent(requestUri)}`;

describe("checkInteractionReachability", () => {
  it("passes a fully public HTTPS setup", () => {
    expect(
      checkInteractionReachability({
        interactionUri: uriWith("https://engine.test.example/presentations/1/oid4vp/request"),
        startUrl: "https://start.test.example/s/abc",
        platformPublicUrl: "https://api.test.example",
      }),
    ).toEqual([]);
  });

  it("flags loopback, because on a phone localhost is the phone", () => {
    const problems = checkInteractionReachability({ startUrl: "http://localhost:3201/s/abc" });
    expect(problems).toHaveLength(1);
    expect(problems[0]?.setting).toBe("TEST_START_PUBLIC_URL");
    expect(problems[0]?.reason).toContain("loopback");
  });

  it("flags a Docker-internal hostname", () => {
    // The value that was actually configured, left over from a conformance run.
    const problems = checkInteractionReachability({
      interactionUri: uriWith("http://eudiplo:3000/presentations/1/oid4vp/request"),
    });
    expect(problems[0]?.setting).toBe("ENGINE_PUBLIC_URL");
    expect(problems[0]?.reason).toContain("Docker network");
  });

  it("flags cleartext even on a public host, because the wallet refuses it", () => {
    const problems = checkInteractionReachability({
      startUrl: "http://start.example.com/s/abc",
    });
    expect(problems[0]?.reason).toContain("cleartext");
  });

  it("reports every problem, not just the first", () => {
    // All three walls at once, which is the real situation. Reporting one at a time would mean three
    // rounds of "fix it, scan again, fail again".
    const problems = checkInteractionReachability({
      interactionUri: uriWith("http://eudiplo:3000/x"),
      startUrl: "http://localhost:3201/s/abc",
      platformPublicUrl: "http://localhost:3100",
    });
    expect(problems.map((p) => p.setting).sort()).toEqual([
      "ENGINE_PUBLIC_URL",
      "PLATFORM_PUBLIC_URL",
      "TEST_START_PUBLIC_URL",
    ]);
  });

  it("says nothing when there is nothing to check", () => {
    expect(checkInteractionReachability({})).toEqual([]);
  });

  it("does not throw on an interaction URI it cannot parse", () => {
    // It runs while rendering a page; a diagnostic that breaks the page it diagnoses is worse than one
    // that stays quiet.
    expect(() => checkInteractionReachability({ interactionUri: "not a uri" })).not.toThrow();
    expect(requestUriOf("not a uri")).toBeUndefined();
    expect(requestUriOf("openid4vp://?client_id=x")).toBeUndefined();
  });
});
