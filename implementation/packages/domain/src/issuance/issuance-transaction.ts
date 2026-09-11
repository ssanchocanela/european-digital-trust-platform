import { PlatformError } from "@edtp/shared";

/**
 * Issuance transaction lifecycle.
 *
 * Table-driven and explicit, like the presentation machine, and for the same reason: an illegal
 * transition is rejected rather than ignored, and the transition log records what was observed
 * rather than what was assumed.
 */
export const ISSUANCE_NON_TERMINAL_STATES = [
  "CREATED",
  "OFFER_READY",
  "AWAITING_WALLET",
  "ELIGIBILITY_CHECK",
  "ISSUING",
] as const;

export const ISSUANCE_TERMINAL_STATES = [
  /** The attestation was issued and the engine confirmed it. */
  "ISSUED",
  /** The eligibility rule said no. A definite, recorded answer — not an error. */
  "NOT_ELIGIBLE",
  /**
   * The User refused in the wallet.
   *
   * Best-effort, as on the verification side: only entered on an explicit protocol signal, and
   * its absence must never be read as consent.
   */
  "DECLINED_BY_USER",
  /** Issuer or wallet trust could not be established. */
  "TRUST_ERROR",
  /** Protocol or engine failure. */
  "PROTOCOL_ERROR",
  /** No wallet response within the transaction lifetime. */
  "EXPIRED",
  /** Cancelled by the business client. */
  "CANCELLED",
] as const;

export type IssuanceNonTerminalState = (typeof ISSUANCE_NON_TERMINAL_STATES)[number];
export type IssuanceTerminalState = (typeof ISSUANCE_TERMINAL_STATES)[number];
export type IssuanceState = IssuanceNonTerminalState | IssuanceTerminalState;

export const ALL_ISSUANCE_STATES: readonly IssuanceState[] = [
  ...ISSUANCE_NON_TERMINAL_STATES,
  ...ISSUANCE_TERMINAL_STATES,
];

export const isIssuanceTerminal = (state: IssuanceState): state is IssuanceTerminalState =>
  (ISSUANCE_TERMINAL_STATES as readonly string[]).includes(state);

/**
 * The transition table.
 *
 * Three deliberate choices, each the mirror of a decision taken on the verification side:
 *
 * - **`CANCELLED` stops at `AWAITING_WALLET`.** Once eligibility has been checked the platform has
 *   already consulted an authentic source about a person; once `ISSUING` has begun an attestation
 *   may exist in a Wallet. Cancelling after either would record no outcome for something that
 *   happened. From `ELIGIBILITY_CHECK` onwards the transaction must settle on a real outcome.
 * - **`NOT_ELIGIBLE` is reachable only from `ELIGIBILITY_CHECK`**, because it is an answer to a
 *   question that must actually have been asked. Reaching it from anywhere else would mean
 *   reporting an eligibility decision that was never made.
 * - **`EXPIRED` is reachable from every non-terminal state**, because the transaction lifetime is
 *   the platform's promise to the customer and must hold even if the engine stops responding.
 *
 * Nothing leaves a terminal state.
 */
const ISSUANCE_TRANSITIONS: Readonly<Record<IssuanceState, readonly IssuanceState[]>> = {
  CREATED: ["OFFER_READY", "PROTOCOL_ERROR", "CANCELLED", "EXPIRED"],
  OFFER_READY: ["AWAITING_WALLET", "PROTOCOL_ERROR", "CANCELLED", "EXPIRED"],
  AWAITING_WALLET: [
    "ELIGIBILITY_CHECK",
    "DECLINED_BY_USER",
    "TRUST_ERROR",
    "PROTOCOL_ERROR",
    "CANCELLED",
    "EXPIRED",
  ],
  ELIGIBILITY_CHECK: ["ISSUING", "NOT_ELIGIBLE", "PROTOCOL_ERROR", "EXPIRED"],
  ISSUING: ["ISSUED", "TRUST_ERROR", "PROTOCOL_ERROR", "EXPIRED"],
  ISSUED: [],
  NOT_ELIGIBLE: [],
  DECLINED_BY_USER: [],
  TRUST_ERROR: [],
  PROTOCOL_ERROR: [],
  EXPIRED: [],
  CANCELLED: [],
};

export const canTransitionIssuance = (from: IssuanceState, to: IssuanceState): boolean =>
  ISSUANCE_TRANSITIONS[from].includes(to);

export const allowedIssuanceTransitionsFrom = (from: IssuanceState): readonly IssuanceState[] =>
  ISSUANCE_TRANSITIONS[from];

export const assertIssuanceTransition = (from: IssuanceState, to: IssuanceState): void => {
  if (!canTransitionIssuance(from, to)) {
    throw PlatformError.conflict(
      "illegal_issuance_transition",
      `An issuance transaction cannot move from ${from} to ${to}.`,
    );
  }
};

export const ISSUANCE_INTERACTION_TYPES = ["SAME_DEVICE", "QR"] as const;
export type IssuanceInteractionType = (typeof ISSUANCE_INTERACTION_TYPES)[number];
