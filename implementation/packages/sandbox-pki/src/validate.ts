import { X509Certificate } from "node:crypto";
import { decodeCompactJws, verifyEs256, x5cCertificates } from "./jws.js";
import type { WrpacCheck } from "./wrpac.js";
import {
  ENTITLEMENT_PID_PROVIDER,
  type RegisteredCredential,
  WRPRC_TYP,
  type WrprcCheck,
} from "./wrprc.js";
import { readKeyUsage } from "./x509.js";

/**
 * Validators for the certificates the sandbox issues — a self-test of the defect catalogue
 * (`docs/sandbox/specification.md` §5): every variant must fail exactly the check its row names, and
 * the correct certificate none. Ported in substance from edt-pid-connector's `AccessCertificateLifecycle`
 * and `Wrprc`/`ComplianceGuard`, and kept to what the sandbox can decide itself: a wallet's own
 * verdict is what the run report records, never what these return (§5.4).
 */
export interface CheckResult<C extends string> {
  readonly check: C;
  readonly passed: boolean;
  readonly detail?: string;
}

const failed = <C extends string>(results: readonly CheckResult<C>[]) =>
  results.filter((r) => !r.passed).map((r) => r.check);

export const failedChecks = failed;

/** The `organizationIdentifier` of a subject, else its `serialNumber` — as Wallet Core binds. */
export function subjectIdentifier(certificate: X509Certificate): string | undefined {
  const lines = certificate.subject.split("\n");
  const pick = (name: string) =>
    lines.find((l) => l.startsWith(`${name}=`))?.slice(name.length + 1);
  return pick("organizationIdentifier") ?? pick("serialNumber");
}

const issuedBy = (leaf: X509Certificate, ca: X509Certificate) =>
  leaf.checkIssued(ca) && leaf.verify(ca.publicKey);

// --- WRPAC -----------------------------------------------------------------------------------

export interface WrpacContext {
  readonly trustedCa: X509Certificate;
  readonly revokedSerials: ReadonlySet<string>;
  readonly expectedDnsNames: readonly string[];
  readonly at: Date;
}

export function validateWrpac(der: Buffer, context: WrpacContext): CheckResult<WrpacCheck>[] {
  const x = new X509Certificate(der);
  const at = context.at.getTime();
  const san = x.subjectAltName ?? "";
  const usage = readKeyUsage(der);
  return [
    { check: "trusted_issuer", passed: issuedBy(x, context.trustedCa) },
    { check: "validity", passed: Date.parse(x.validFrom) <= at && at < Date.parse(x.validTo) },
    { check: "not_revoked", passed: !context.revokedSerials.has(x.serialNumber.toUpperCase()) },
    {
      check: "organization_identifier",
      passed: x.subject.split("\n").some((l) => l.startsWith("organizationIdentifier=")),
    },
    {
      check: "san_dns",
      passed: context.expectedDnsNames.every((d) => san.includes(`DNS:${d}`)),
    },
    {
      check: "key_usage",
      passed: usage.length === 1 && usage[0] === "digitalSignature",
      detail: usage.join(","),
    },
  ];
}

// --- the compliance guard --------------------------------------------------------------------

export interface RequestedClaim {
  readonly format: "dc+sd-jwt" | "mso_mdoc";
  readonly type: string;
  readonly path: readonly (string | number | null)[];
}

/**
 * Wallet Core's coverage rule (edt-pid-connector spec-delta D-22): a registered path covers a
 * requested one when it is a prefix of it, element by element, `null` matching any array index; a
 * registered credential with no claims covers every claim of its type; no registered credential of
 * the format and type covers nothing.
 */
export function findOverAsked(
  registered: readonly RegisteredCredential[],
  requested: readonly RequestedClaim[],
): RequestedClaim[] {
  const covers = (
    reg: readonly (string | number | null)[],
    req: readonly (string | number | null)[],
  ) =>
    reg.length <= req.length &&
    reg.every((element, i) => element === null || element === req[i]);
  return requested.filter(
    (r) =>
      !registered.some(
        (c) =>
          c.format === r.format &&
          c.types.includes(r.type) &&
          (c.claims.length === 0 || c.claims.some((path) => covers(path, r.path))),
      ),
  );
}

// --- WRPRC -----------------------------------------------------------------------------------

export interface WrprcContext {
  readonly trustedRegistrar: X509Certificate;
  readonly accessCertificate: X509Certificate;
  readonly at: Date;
  readonly kind: "service_provider" | "pid_provider";
  readonly statusOf: (uri: string, index: number) => "valid" | "revoked" | "unreachable";
  /** What a presentation would request: checked against `credentials` (RPRC_21). */
  readonly requested?: readonly RequestedClaim[];
  /** What the provider would issue: checked against `provides_attestations` (RPRC_23). */
  readonly issuedType?: string;
}

const addMonths = (seconds: number, months: number) => {
  const d = new Date(seconds * 1000);
  d.setUTCMonth(d.getUTCMonth() + months);
  return Math.floor(d.getTime() / 1000);
};

export function validateWrprc(
  compact: string,
  context: WrprcContext,
): CheckResult<WrprcCheck>[] {
  const jws = decodeCompactJws(compact);
  const p = jws.payload;
  const chain = x5cCertificates(jws.header);
  const leaf = chain[0];
  const status = (p.status as { status_list?: { idx?: number; uri?: string } } | undefined)
    ?.status_list;
  const lookup =
    status?.uri !== undefined && status.idx !== undefined
      ? context.statusOf(status.uri, status.idx)
      : undefined;
  const results: CheckResult<WrprcCheck>[] = [
    {
      check: "format",
      passed:
        jws.header.typ === WRPRC_TYP &&
        typeof p.sub === "string" &&
        typeof p.name === "string" &&
        Array.isArray(p.entitlements) &&
        typeof p.iat === "number",
    },
    { check: "signature", passed: leaf !== undefined && verifyEs256(jws, leaf.publicKey) },
    {
      check: "trusted_provider",
      passed:
        leaf !== undefined &&
        (issuedBy(leaf, context.trustedRegistrar) ||
          leaf.fingerprint256 === context.trustedRegistrar.fingerprint256),
    },
    {
      check: "not_expired",
      passed: typeof p.exp !== "number" || p.exp * 1000 > context.at.getTime(),
    },
    {
      check: "bound_to_access_certificate",
      passed: p.sub === subjectIdentifier(context.accessCertificate),
    },
    { check: "status_present", passed: status !== undefined },
    { check: "status_reachable", passed: lookup === undefined || lookup !== "unreachable" },
    { check: "not_revoked", passed: lookup !== "revoked" },
    {
      check: "validity_period",
      passed:
        typeof p.exp !== "number" || typeof p.iat !== "number" || p.exp <= addMonths(p.iat, 12),
    },
  ];
  if (context.kind === "service_provider" && context.requested) {
    const registered = (
      (p.credentials as {
        format: RegisteredCredential["format"];
        meta: Record<string, unknown>;
        claim?: { path: (string | number | null)[] }[];
      }[]) ?? []
    ).map(
      (c): RegisteredCredential => ({
        format: c.format,
        types: (c.meta.vct_values as string[] | undefined) ?? [String(c.meta.doctype_value)],
        claims: (c.claim ?? []).map((cl) => cl.path),
      }),
    );
    const over = findOverAsked(registered, context.requested);
    results.push({
      check: "covers_request",
      passed: over.length === 0,
      detail: over.map((o) => o.path.join(".")).join(" "),
    });
  }
  if (context.kind === "pid_provider") {
    const entitlements = (p.entitlements as string[] | undefined) ?? [];
    results.push({
      check: "entitlement",
      passed: entitlements.includes(ENTITLEMENT_PID_PROVIDER),
    });
    if (context.issuedType) {
      const provided = (
        (p.provides_attestations as { meta: Record<string, unknown> }[]) ?? []
      ).flatMap(
        (a) => (a.meta.vct_values as string[] | undefined) ?? [String(a.meta.doctype_value)],
      );
      results.push({
        check: "provides_attestation",
        passed: provided.includes(context.issuedType),
      });
    }
  }
  return results;
}
