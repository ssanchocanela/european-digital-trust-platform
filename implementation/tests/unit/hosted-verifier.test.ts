import { HostedVerifierController } from "@edtp/platform-api/http/wallet-initiated.controllers.js";
import { HostedFormReturns } from "@edtp/platform-api/modules/issuances/hosted-form-returns.js";
import { describe, expect, it } from "vitest";

/**
 * The hosted verifier's two per-policy openings: an origin of its own for the wallet's return, and
 * cross-device (`QR`) requests. Both are configuration; neither is something the page can ask its
 * way into (ADR 0012).
 */
const SECRET = "s".repeat(40);
const BANK = "11111111-1111-4111-8111-111111111111";
const HORIZONTE = "22222222-2222-4222-8222-222222222222";
const PRESENTATION = "33333333-3333-4333-8333-333333333333";

const build = () => {
  const created: { policyId: string; interactionType: string }[] = [];
  const returns = new HostedFormReturns();
  const config = {
    HOSTED_VERIFIER_SECRET: SECRET,
    HOSTED_VERIFIER_PUBLIC_URL: "https://bank.example.test",
    HOSTED_VERIFIER_POLICIES: [
      { tenantId: "t-1", policyId: BANK },
      { tenantId: "t-1", policyId: HORIZONTE },
    ],
    HOSTED_VERIFIER_ORIGINS: { [HORIZONTE]: "https://horizonte.example.test" },
    HOSTED_VERIFIER_QR_POLICIES: [HORIZONTE],
  };
  const presentations = {
    create: async (command: { policyId: string; interactionType: string }) => {
      created.push({ policyId: command.policyId, interactionType: command.interactionType });
      return {
        presentationId: PRESENTATION,
        interaction: { type: command.interactionType, uri: "openid4vp://?request_uri=x" },
        expiresAt: new Date(Date.now() + 120_000),
      };
    },
  };
  const controller = new HostedVerifierController(
    config as never,
    presentations as never,
    returns,
  );
  return { controller, created, returns };
};

describe("the hosted verifier", () => {
  it("asks for the tested path when the page sends no body", async () => {
    const { controller, created, returns } = build();
    const started = await controller.start(SECRET, BANK, undefined);
    expect(created).toEqual([{ policyId: BANK, interactionType: "SAME_DEVICE" }]);
    expect(started.interactionType).toBe("SAME_DEVICE");
    expect(returns.destination(PRESENTATION)).toBe(
      `https://bank.example.test/resultado?policy=${BANK}&presentation=${PRESENTATION}`,
    );
  });

  it("returns the wallet to the origin configured for the policy", async () => {
    const { controller, returns } = build();
    await controller.start(SECRET, HORIZONTE, {});
    expect(returns.destination(PRESENTATION)).toBe(
      `https://horizonte.example.test/resultado?policy=${HORIZONTE}&presentation=${PRESENTATION}`,
    );
  });

  it("opens cross-device only for a policy configuration names", async () => {
    const { controller, created } = build();
    await expect(
      controller.start(SECRET, BANK, { interactionType: "QR" }),
    ).rejects.toMatchObject({ code: "hosted_verifier_cross_device_not_allowed" });
    expect(created).toEqual([]);
    const started = await controller.start(SECRET, HORIZONTE, { interactionType: "QR" });
    expect(started.interactionType).toBe("QR");
  });

  it("gives a cross-device presentation no return at all", async () => {
    const { controller, returns } = build();
    await controller.start(SECRET, HORIZONTE, { interactionType: "QR" });
    expect(returns.destination(PRESENTATION)).toBeUndefined();
  });

  it("refuses a body it does not know, and a wrong secret", async () => {
    const { controller } = build();
    await expect(controller.start(SECRET, BANK, { returnUrl: "https://x" })).rejects.toThrow();
    await expect(controller.start("x".repeat(40), BANK, {})).rejects.toMatchObject({
      code: "unauthenticated",
    });
  });
});
