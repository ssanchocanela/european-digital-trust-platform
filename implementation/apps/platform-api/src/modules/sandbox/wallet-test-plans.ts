import {
  EAA_VARIANT_INFO,
  type EaaVariant,
  PID_VARIANT_INFO,
  type PidSigningVariant,
  WRPAC_VARIANT_INFO,
  WRPRC_VARIANT_INFO,
  type WrpacVariant,
  type WrprcVariant,
} from "@edtp/sandbox-pki";

/**
 * The sandbox's wallet test plans (ADR 0022 §2): existing hosted-verifier and hosted-issuer runs, in
 * order, each with a fixed defect variant. The plans are the sandbox's, so every step stays tied to
 * the defect catalogue and its citations. A plan's steps never change under the same version.
 *
 * `asks` says what the cited requirement asks of a wallet, as the S4 and S5 run sheets state it — the
 * report puts it next to what was observed, and draws no conclusion.
 */
export type PlanStep =
  | {
      readonly kind: "verifier";
      readonly accessVariant: WrpacVariant;
      readonly registrationVariant: WrprcVariant;
      /** The wallet's *Check Registration Certificates* position the tester is asked to set. */
      readonly checkRegistrationCertificates: "on" | "off";
      readonly title: string;
      readonly asks: string;
      readonly requirement: string;
    }
  | {
      readonly kind: "issuer";
      readonly signingVariant: PidSigningVariant | EaaVariant;
      readonly title: string;
      readonly asks: string;
      readonly requirement: string;
    };

export interface WalletTestPlan {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  /** The service role the plan runs on. */
  readonly role: "service_provider" | "pid_provider" | "eaa_provider";
  readonly steps: readonly PlanStep[];
}

const verifier = (
  accessVariant: WrpacVariant,
  registrationVariant: WrprcVariant,
  checkRegistrationCertificates: "on" | "off",
  asks: string,
): PlanStep => ({
  kind: "verifier",
  accessVariant,
  registrationVariant,
  checkRegistrationCertificates,
  title: `${accessVariant} ${WRPAC_VARIANT_INFO[accessVariant].title} · ${registrationVariant} ${WRPRC_VARIANT_INFO[registrationVariant].title} · check ${checkRegistrationCertificates}`,
  asks,
  requirement:
    accessVariant !== "AC-00"
      ? WRPAC_VARIANT_INFO[accessVariant].requirement
      : WRPRC_VARIANT_INFO[registrationVariant].requirement,
});

const RP_REGISTRATION_VARIANTS: readonly WrprcVariant[] = [
  "RC-01",
  "RC-02",
  "RC-03",
  "RC-04",
  "RC-05",
  "RC-06",
  "RC-07",
  "RC-08",
  "RC-09",
  "RC-10",
  "RC-13",
];

export const WALLET_TEST_PLANS: readonly WalletTestPlan[] = [
  {
    id: "access-certificates",
    version: 1,
    title: "Access certificate defects (hosted verifier)",
    role: "service_provider",
    steps: [
      verifier("AC-00", "RC-00", "off", "Presents: the baseline, nothing is wrong."),
      verifier(
        "AC-01",
        "RC-00",
        "off",
        "Stops: the access certificate's CA is not on the Access CA list.",
      ),
      verifier("AC-02", "RC-00", "off", "Fails the access certificate's validity check."),
      verifier("AC-03", "RC-00", "off", "Fails the access certificate's validity check."),
      verifier(
        "AC-04",
        "RC-00",
        "off",
        "The access certificate is revoked. No HLR states the wallet's duty; ARF §6.6.3.2 describes revocation.",
      ),
      verifier(
        "AC-05",
        "RC-00",
        "on",
        "The registration certificate cannot be bound to this access certificate.",
      ),
      verifier(
        "AC-06",
        "RC-00",
        "off",
        "The x509_san_dns client identifier is not in the certificate's SAN.",
      ),
    ],
  },
  {
    id: "registration-certificates",
    version: 1,
    title: "Registration certificate defects (hosted verifier)",
    role: "service_provider",
    steps: [
      verifier(
        "AC-00",
        "RC-00",
        "on",
        "Presents, with no warning: the baseline with the check on.",
      ),
      ...RP_REGISTRATION_VARIANTS.flatMap((v) => [
        verifier(
          "AC-00",
          v,
          "on",
          `With the check on, the wallet applies the registration certificate requirement cited for "${WRPRC_VARIANT_INFO[v].title}".`,
        ),
        verifier(
          "AC-00",
          v,
          "off",
          "With the check off, the wallet does not check registration certificates: nothing should change from the baseline.",
        ),
      ]),
    ],
  },
  {
    id: "issuance",
    version: 1,
    title: "PID issuance (hosted issuer)",
    role: "pid_provider",
    steps: (["PID-00", "PID-01", "PID-02"] as const).map((v) => ({
      kind: "issuer" as const,
      signingVariant: v,
      title: `${v} ${PID_VARIANT_INFO[v].title}`,
      asks:
        v === "PID-00"
          ? "Issued and stored: the baseline."
          : v === "PID-01"
            ? "The wallet refuses the PID: its signature cannot be verified against the PID list."
            : "The wallet refuses the PID: its signing certificate has expired.",
      requirement: PID_VARIANT_INFO[v].requirement,
    })),
  },
  {
    // ADR 0023 §7. On the participant's own hosted EAA issuer, with the sandbox's test type
    // (`edtp-wallet-test`, created on the service the first time). `AS-AP-10-010` (`ISSU_10`) is
    // conditional, so what it asks depends on whether the wallet holds the sandbox EAA list.
    id: "eaa-issuance",
    version: 1,
    title: "Non-qualified EAA issuance (hosted EAA issuer)",
    role: "eaa_provider",
    steps: (["EAA-00", "EAA-01", "EAA-02"] as const).map((v) => ({
      kind: "issuer" as const,
      signingVariant: v,
      title: `${v} ${EAA_VARIANT_INFO[v].title}`,
      asks:
        v === "EAA-00"
          ? "Issued and stored: the baseline. A wallet without the sandbox EAA list may still refuse it, as it holds no anchor for it."
          : v === "EAA-01"
            ? "A wallet that holds the sandbox EAA list validates the signature and cannot verify it against that list. ISSU_10 asks nothing of a wallet without the list."
            : "A wallet that holds the sandbox EAA list finds the signing certificate expired. ISSU_10 asks nothing of a wallet without the list.",
      requirement: EAA_VARIANT_INFO[v].requirement,
    })),
  },
];

export const planById = (id: string) => WALLET_TEST_PLANS.find((p) => p.id === id);
