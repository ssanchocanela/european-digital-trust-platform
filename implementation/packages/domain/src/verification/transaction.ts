import type {
  EngineSessionRef,
  PresentationId,
  PresentationPolicyId,
  RelyingPartyServiceId,
  TenantId,
} from "@edtp/shared";
import { PlatformError } from "@edtp/shared";
import type { NormalisedClaims } from "./result-policy.js";

/**
 * Presentation transaction lifecycle.
 *
 * All transitions are explicit and table-driven, and illegal transitions are rejected
 * rather than ignored.
 */
export const NON_TERMINAL_STATES = [
  "CREATED",
  "REQUEST_READY",
  "AWAITING_WALLET",
  "PRESENTATION_RECEIVED",
  "VERIFYING",
] as const;

export const TERMINAL_STATES = [
  /** Presentation valid and policy satisfied. */
  "VERIFIED",
  /** Credential verification failed: signature, validity, status or revocation. */
  "REJECTED",
  /** A valid presentation that does not satisfy the policy. */
  "POLICY_NOT_SATISFIED",
  /**
   * The user refused in the wallet, e.g. an OpenID4VP `access_denied`.
   *
   * Best-effort by construction: `AS-WP-06-017` (`RPA_11`) requires a Wallet Unit,
   * when the User denies a presentation, to "behave towards the Relying Party as if
   * the attestation or PID did not exist". A denial is therefore not reliably
   * distinguishable from non-possession, so this state is only entered on an explicit
   * protocol error and its absence must never be read as consent.
   */
  "DECLINED_BY_USER",
  /** Issuer or attestation trust could not be established. */
  "TRUST_ERROR",
  /** Protocol or engine failure. */
  "PROTOCOL_ERROR",
  /** No wallet response within the transaction lifetime. */
  "EXPIRED",
  /** Cancelled by the business client. */
  "CANCELLED",
] as const;

export type NonTerminalState = (typeof NON_TERMINAL_STATES)[number];
export type TerminalState = (typeof TERMINAL_STATES)[number];
export type PresentationState = NonTerminalState | TerminalState;

export const ALL_STATES: readonly PresentationState[] = [
  ...NON_TERMINAL_STATES,
  ...TERMINAL_STATES,
];

export const isTerminal = (state: PresentationState): state is TerminalState =>
  (TERMINAL_STATES as readonly string[]).includes(state);

/**
 * The transition table.
 *
 * Two deliberate asymmetries:
 *
 * - **`CANCELLED` is only reachable while the platform is still waiting on the wallet.**
 *   Once a presentation has been received the User has already disclosed attributes, and
 *   letting a business client cancel at that point would record no outcome for a
 *   disclosure that did happen. From `PRESENTATION_RECEIVED` onwards the transaction must
 *   settle on a real outcome.
 * - **`EXPIRED` is reachable from every non-terminal state**, because the transaction
 *   lifetime is the platform's promise to the customer and must hold even if the engine
 *   stops responding mid-verification.
 *
 * Nothing leaves a terminal state.
 */
const TRANSITIONS: Readonly<Record<PresentationState, readonly PresentationState[]>> = {
  CREATED: ["REQUEST_READY", "PROTOCOL_ERROR", "CANCELLED", "EXPIRED"],
  REQUEST_READY: ["AWAITING_WALLET", "PROTOCOL_ERROR", "CANCELLED", "EXPIRED"],
  AWAITING_WALLET: [
    "PRESENTATION_RECEIVED",
    "DECLINED_BY_USER",
    "PROTOCOL_ERROR",
    "CANCELLED",
    "EXPIRED",
  ],
  PRESENTATION_RECEIVED: ["VERIFYING", "PROTOCOL_ERROR", "EXPIRED"],
  VERIFYING: [
    "VERIFIED",
    "REJECTED",
    "POLICY_NOT_SATISFIED",
    "TRUST_ERROR",
    "PROTOCOL_ERROR",
    "EXPIRED",
  ],
  VERIFIED: [],
  REJECTED: [],
  POLICY_NOT_SATISFIED: [],
  DECLINED_BY_USER: [],
  TRUST_ERROR: [],
  PROTOCOL_ERROR: [],
  EXPIRED: [],
  CANCELLED: [],
};

export const canTransition = (from: PresentationState, to: PresentationState): boolean =>
  TRANSITIONS[from].includes(to);

export const allowedTransitionsFrom = (from: PresentationState): readonly PresentationState[] =>
  TRANSITIONS[from];

export const assertTransition = (from: PresentationState, to: PresentationState): void => {
  if (!canTransition(from, to)) {
    throw PlatformError.conflict(
      "illegal_transaction_transition",
      `A presentation transaction cannot move from ${from} to ${to}.`,
    );
  }
};

/**
 * Result delivery is tracked separately from the transaction outcome, so a delivery
 * failure never changes the verification outcome and a retry never re-verifies.
 */
export const DELIVERY_STATUSES = ["NOT_REQUIRED", "PENDING", "DELIVERED", "FAILED"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

const DELIVERY_TRANSITIONS: Readonly<Record<DeliveryStatus, readonly DeliveryStatus[]>> = {
  NOT_REQUIRED: [],
  PENDING: ["DELIVERED", "FAILED"],
  DELIVERED: [],
  FAILED: ["PENDING"], // an operator or scheduled retry may re-queue a failed delivery
};

export const canTransitionDelivery = (from: DeliveryStatus, to: DeliveryStatus): boolean =>
  DELIVERY_TRANSITIONS[from].includes(to);

export const assertDeliveryTransition = (from: DeliveryStatus, to: DeliveryStatus): void => {
  if (!canTransitionDelivery(from, to)) {
    throw PlatformError.conflict(
      "illegal_delivery_transition",
      `Result delivery cannot move from ${from} to ${to}.`,
    );
  }
};

export const INTERACTION_TYPES = ["SAME_DEVICE", "QR"] as const;
export type InteractionType = (typeof INTERACTION_TYPES)[number];

/**
 * Transaction metadata. This record holds **no** presentation content: no VP token, no
 * credential, no disclosed claim value. The normalised result lives in a separate
 * record, and content has no table at all — ADR 0004.
 */
export interface PresentationTransaction {
  readonly id: PresentationId;
  readonly tenantId: TenantId;
  readonly relyingPartyServiceId: RelyingPartyServiceId;
  readonly policyId: PresentationPolicyId;
  readonly policyVersion: number;
  readonly businessReference: string;
  readonly state: PresentationState;
  readonly interactionType: InteractionType;
  readonly deliveryStatus: DeliveryStatus;
  /** Registered callback URL, resolved from the service allow-list. */
  readonly callbackUrl?: string;
  /**
   * Internal correlation only. Never exposed in the business API, because it is an
   * engine identifier and the business API carries no engine contracts.
   */
  readonly engineSessionRef?: EngineSessionRef;
  /** Machine-readable failure code from the engine, for diagnosis. */
  readonly failureCode?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly expiresAt: Date;
  readonly closedAt?: Date;
}

/** An append-only record of every state change, used as audit evidence. */
export interface PresentationTransactionTransition {
  readonly presentationId: PresentationId;
  readonly sequence: number;
  readonly fromState: PresentationState;
  readonly toState: PresentationState;
  readonly reason: string;
  readonly at: Date;
}

/**
 * The normalised, minimised result. Separate from transaction metadata because it is a
 * different data class with a different lifecycle.
 */
export interface PresentationResult {
  readonly presentationId: PresentationId;
  readonly tenantId: TenantId;
  readonly claims: NormalisedClaims;
  readonly createdAt: Date;
  /** When this result becomes unreadable and is purged. */
  readonly purgeAfter: Date;
}

export const isExpired = (tx: PresentationTransaction, at: Date): boolean =>
  !isTerminal(tx.state) && tx.expiresAt.getTime() <= at.getTime();
