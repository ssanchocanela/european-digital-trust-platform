import {
  type IssuePidSigningInput,
  issueAttestationSigningCertificate,
} from "./pid-signing.js";

/**
 * A participant EAA Provider's attestation-signing certificate, issued by the sandbox EAA CA
 * (ADR 0023 §3), and its defect variants (§4). The profile is the PID signing certificate's.
 *
 * The citation is `AS-AP-10-010` (`ISSU_10`), verified in the HLR register at the pinned ARF commit.
 * It is **conditional**: a Wallet Unit validates a non-qualified EAA's signature *if it has access to*
 * the EAA Provider's trust anchors. So EAA-01 asks a wallet that holds the sandbox EAA list to refuse,
 * and asks nothing of one that does not.
 */
export const EAA_VARIANTS = ["EAA-00", "EAA-01", "EAA-02"] as const;
export type EaaVariant = (typeof EAA_VARIANTS)[number];

export interface EaaVariantInfo {
  readonly title: string;
  readonly issuer: "eaa-ca" | "eaa-ca-untrusted";
  readonly requirement: string;
}

const ISSU_10 = "AS-AP-10-010 (ISSU_10), if the wallet has the EAA list";

export const EAA_VARIANT_INFO: Readonly<Record<EaaVariant, EaaVariantInfo>> = {
  "EAA-00": { title: "Correct", issuer: "eaa-ca", requirement: "—" },
  "EAA-01": {
    title: "Signing certificate not on the EAA list",
    issuer: "eaa-ca-untrusted",
    requirement: ISSU_10,
  },
  "EAA-02": { title: "Signing certificate expired", issuer: "eaa-ca", requirement: ISSU_10 },
};

export function issueEaaSigningCertificate(
  input: Omit<IssuePidSigningInput, "variant"> & { readonly variant: EaaVariant },
): { readonly der: Buffer; readonly serial: Buffer } {
  const { variant, ...rest } = input;
  return issueAttestationSigningCertificate({ ...rest, expired: variant === "EAA-02" });
}
