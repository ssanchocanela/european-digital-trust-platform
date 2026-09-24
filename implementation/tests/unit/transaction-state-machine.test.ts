import type { PresentationState } from "@edtp/domain";
import {
  ALL_STATES,
  allowedTransitionsFrom,
  assertDeliveryTransition,
  assertTransition,
  canTransition,
  canTransitionDelivery,
  DELIVERY_STATUSES,
  isTerminal,
  NON_TERMINAL_STATES,
  TERMINAL_STATES,
} from "@edtp/domain";
import { PlatformError } from "@edtp/shared";
import { describe, expect, it } from "vitest";

/**
 * The presentation transaction state machine.
 *
 * Illegal transitions must be **rejected**, not ignored: a transaction that slid from
 * `AWAITING_WALLET` straight to `VERIFIED` would produce an audit trail that never
 * recorded receiving or verifying anything.
 */
describe("transition table", () => {
  it("covers every state", () => {
    for (const state of ALL_STATES) {
      expect(allowedTransitionsFrom(state)).toBeDefined();
    }
  });

  it("makes every terminal state absorbing", () => {
    for (const state of TERMINAL_STATES) {
      expect(isTerminal(state)).toBe(true);
      expect(allowedTransitionsFrom(state)).toHaveLength(0);
    }
  });

  it("allows the happy path only in order", () => {
    expect(canTransition("CREATED", "REQUEST_READY")).toBe(true);
    expect(canTransition("REQUEST_READY", "AWAITING_WALLET")).toBe(true);
    expect(canTransition("AWAITING_WALLET", "PRESENTATION_RECEIVED")).toBe(true);
    expect(canTransition("PRESENTATION_RECEIVED", "VERIFYING")).toBe(true);
    expect(canTransition("VERIFYING", "VERIFIED")).toBe(true);
  });

  it("refuses to skip the intermediate states", () => {
    expect(canTransition("AWAITING_WALLET", "VERIFIED")).toBe(false);
    expect(canTransition("CREATED", "VERIFYING")).toBe(false);
    expect(canTransition("REQUEST_READY", "POLICY_NOT_SATISFIED")).toBe(false);
  });

  it("refuses to move backwards", () => {
    expect(canTransition("VERIFYING", "AWAITING_WALLET")).toBe(false);
    expect(canTransition("AWAITING_WALLET", "CREATED")).toBe(false);
  });

  it("never leaves a terminal state, including to another terminal state", () => {
    for (const from of TERMINAL_STATES) {
      for (const to of ALL_STATES) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it("allows cancellation only while still waiting on the wallet", () => {
    // A business client may abandon a transaction before the User discloses anything.
    expect(canTransition("CREATED", "CANCELLED")).toBe(true);
    expect(canTransition("REQUEST_READY", "CANCELLED")).toBe(true);
    expect(canTransition("AWAITING_WALLET", "CANCELLED")).toBe(true);

    // Once a presentation has been received the User has already disclosed attributes.
    // Cancelling then would leave no recorded outcome for a disclosure that happened.
    expect(canTransition("PRESENTATION_RECEIVED", "CANCELLED")).toBe(false);
    expect(canTransition("VERIFYING", "CANCELLED")).toBe(false);
  });

  it("allows expiry from any non-terminal state", () => {
    for (const state of NON_TERMINAL_STATES) {
      expect(canTransition(state, "EXPIRED")).toBe(true);
    }
  });

  it("only allows DECLINED_BY_USER while waiting on the wallet", () => {
    // The refusal happens in the wallet, so it can only be observed while the platform is
    // waiting for a wallet response.
    expect(canTransition("AWAITING_WALLET", "DECLINED_BY_USER")).toBe(true);
    expect(canTransition("VERIFYING", "DECLINED_BY_USER")).toBe(false);
    expect(canTransition("CREATED", "DECLINED_BY_USER")).toBe(false);
  });

  it("only reaches verification outcomes from VERIFYING", () => {
    const outcomes: PresentationState[] = [
      "VERIFIED",
      "REJECTED",
      "POLICY_NOT_SATISFIED",
      "TRUST_ERROR",
    ];
    for (const outcome of outcomes) {
      for (const from of NON_TERMINAL_STATES) {
        expect(canTransition(from, outcome)).toBe(from === "VERIFYING");
      }
    }
  });

  it("throws a conflict with both states named", () => {
    expect(() => assertTransition("AWAITING_WALLET", "VERIFIED")).toThrowError(PlatformError);
    try {
      assertTransition("AWAITING_WALLET", "VERIFIED");
    } catch (error) {
      const platformError = error as PlatformError;
      expect(platformError.kind).toBe("CONFLICT");
      expect(platformError.code).toBe("illegal_transaction_transition");
      expect(platformError.message).toContain("AWAITING_WALLET");
      expect(platformError.message).toContain("VERIFIED");
    }
  });
});

describe("delivery status", () => {
  it("tracks delivery separately from the verification outcome", () => {
    // A delivery failure must never change what was verified.
    expect(canTransitionDelivery("PENDING", "DELIVERED")).toBe(true);
    expect(canTransitionDelivery("PENDING", "FAILED")).toBe(true);
  });

  it("allows a failed delivery to be re-queued but not un-delivered", () => {
    expect(canTransitionDelivery("FAILED", "PENDING")).toBe(true);
    expect(canTransitionDelivery("DELIVERED", "PENDING")).toBe(false);
    expect(canTransitionDelivery("DELIVERED", "FAILED")).toBe(false);
  });

  it("never transitions out of NOT_REQUIRED", () => {
    for (const to of DELIVERY_STATUSES) {
      expect(canTransitionDelivery("NOT_REQUIRED", to)).toBe(false);
    }
  });

  it("throws a conflict on an illegal delivery transition", () => {
    expect(() => assertDeliveryTransition("DELIVERED", "PENDING")).toThrowError(PlatformError);
  });
});
