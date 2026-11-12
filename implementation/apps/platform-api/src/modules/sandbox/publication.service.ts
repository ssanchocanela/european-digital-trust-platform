import { createHash } from "node:crypto";
import type { SandboxCertificateRepository } from "@edtp/persistence";
import {
  hexToSerial,
  issueCrl,
  type ListKind,
  signLote,
  signStatusListToken,
} from "@edtp/sandbox-pki";
import { type Clock, newUuid } from "@edtp/shared";
import type { Logger } from "../../logging/logger.js";
import type { SandboxTrustDomain } from "./trust-domain.runtime.js";
import type { SandboxUrls } from "./urls.js";

/**
 * Everything the sandbox publishes, re-signed when its content changes and well before it lapses
 * (specification §7.3, ADR 0014 Decision 4):
 *
 * | Channel | Validity | Source |
 * |---|---|---|
 * | `crl:<ca>` | 24 h (EN 319 411-1 CSS-6.3.9-05) | revoked access certificates of that CA |
 * | `status:<signing key>` | 24 h, cache 1 h | revoked registration certificates it signed |
 * | `lote:<kind>` | 7 days (at most 6 months, TS 119 602) | the trust domain's listed CAs |
 *
 * Each publication is kept with its sequence number — the CRL number and the LoTE sequence number are
 * that sequence — so the history the ARF asks for (`AS-WP-31-014`, `TLPub_08`) is a query.
 */
export const CRL_CHANNELS = ["access-ca", "access-ca-untrusted"] as const;
export const STATUS_CHANNELS = ["registrar-signing", "registrar-untrusted-signing"] as const;
export const LOTE_KINDS: readonly ListKind[] = ["WRPAC", "WRPRC", "PID"];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Lists are sized for a herd: an index is hidden among at least this many. */
export const MIN_STATUS_LIST_SIZE = 16_384;
const OPERATOR_EMAIL = "operator@sandbox.invalid";

interface Built {
  readonly contentHash: string;
  readonly validityMs: number;
  /** Re-issue unchanged content once less than this is left. */
  readonly refreshMarginMs: number;
  sign(sequence: number, now: Date, nextUpdate: Date): Promise<string>;
}

const isUniqueViolation = (error: unknown): boolean => {
  for (
    let e: unknown = error, depth = 0;
    e && depth < 5;
    e = (e as { cause?: unknown }).cause, depth++
  ) {
    if ((e as { code?: unknown }).code === "23505") return true;
  }
  return false;
};

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class SandboxPublicationService {
  private lastSweep = 0;

  constructor(
    private readonly repository: SandboxCertificateRepository,
    private readonly domain: SandboxTrustDomain,
    private readonly urls: SandboxUrls,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  private async build(channel: string): Promise<Built> {
    const [family, name] = channel.split(":") as [string, string];
    const revocations = await this.repository.revocations();
    if (family === "crl") {
      const revoked = revocations
        .filter((r) => r.issuerKey === name && r.serialHex)
        .map((r) => ({ serialHex: r.serialHex as string, revokedAt: r.revokedAt }))
        .sort((a, b) => a.serialHex.localeCompare(b.serialHex));
      return {
        contentHash: hash(revoked.map((r) => [r.serialHex, r.revokedAt.toISOString()])),
        validityMs: DAY,
        refreshMarginMs: 12 * HOUR,
        sign: async (sequence, now, nextUpdate) =>
          issueCrl(
            {
              issuer: this.domain.name(name),
              thisUpdate: now,
              nextUpdate,
              crlNumber: BigInt(sequence),
              revoked: revoked.map((r) => ({
                serial: hexToSerial(r.serialHex),
                revokedAt: r.revokedAt,
              })),
            },
            await this.domain.signer(name),
          ).toString("base64"),
      };
    }
    if (family === "status") {
      const indexes = revocations
        .filter((r) => r.issuerKey === name && r.statusIndex !== undefined)
        .map((r) => r.statusIndex as number)
        .sort((a, b) => a - b);
      const max = await this.repository.maxStatusIndex();
      let size = MIN_STATUS_LIST_SIZE;
      while (size <= max) size *= 2;
      return {
        contentHash: hash([size, indexes]),
        validityMs: DAY,
        refreshMarginMs: 12 * HOUR,
        sign: async (_sequence, now) =>
          signStatusListToken({
            uri: this.urls.statusList(name),
            revoked: new Set(indexes),
            size,
            issuedAt: now,
            validitySeconds: DAY / 1000,
            ttlSeconds: HOUR / 1000,
            signer: await this.domain.signer(name),
            chain: this.domain.chainOf(name),
          }),
      };
    }
    if (family === "lote") {
      const kind = name as ListKind;
      const own = {
        name: "EDTP Sandbox — TEST ONLY",
        tradeName: "EDTP Sandbox (TEST)",
        informationUri: this.urls.information,
        email: OPERATOR_EMAIL,
      };
      const ca = kind === "WRPAC" ? "access-ca" : kind === "WRPRC" ? "registrar" : "pid-ca";
      const entities = [
        {
          ...own,
          anchors: [
            {
              serviceName:
                this.domain
                  .x509(ca)
                  .subject.split("\n")
                  .find((l) => l.startsWith("CN="))
                  ?.slice(3) ?? ca,
              certificate: this.domain.certificate(ca),
            },
          ],
        },
        // The PID list also carries the sign-in anchors, so a sandbox wallet can hold the PID it
        // signs in with (ADR 0014 Decision 5). Participants' anchors are added in S5.
        ...(kind === "PID" && this.domain.pidSignInAnchors.length
          ? [
              {
                name: "PID Providers trusted for sandbox sign-in — carried for TEST use, not operated by the sandbox",
                tradeName: "Sign-in PID Providers",
                informationUri: this.urls.information,
                email: OPERATOR_EMAIL,
                anchors: this.domain.pidSignInAnchors.map((a) => ({
                  serviceName: a.name,
                  certificate: a.certificate,
                })),
              },
            ]
          : []),
      ];
      return {
        contentHash: hash(
          entities.map((e) => [e.name, e.anchors.map((a) => a.certificate.toString("base64"))]),
        ),
        validityMs: 7 * DAY,
        refreshMarginMs: 2 * DAY,
        sign: async (sequence, now, nextUpdate) =>
          signLote({
            kind,
            sequenceNumber: sequence,
            issuedAt: now,
            nextUpdate,
            publicationUrl: this.urls.lote(kind),
            informationUrl: this.urls.information,
            operatorEmail: OPERATOR_EMAIL,
            entities,
            signer: await this.domain.signer("lote-signer"),
            signerCertificate: this.domain.certificate("lote-signer"),
          }),
      };
    }
    throw new Error(`unknown channel ${channel}`);
  }

  /** Publish `channel` if its content changed or its current publication nears its next update. */
  async publishIfNeeded(channel: string): Promise<boolean> {
    const built = await this.build(channel);
    const latest = await this.repository.latestPublication(channel);
    const now = this.clock.now();
    if (
      latest &&
      latest.contentHash === built.contentHash &&
      latest.nextUpdate.getTime() - now.getTime() > built.refreshMarginMs
    ) {
      return false;
    }
    const sequence = (latest?.sequence ?? 0) + 1;
    const nextUpdate = new Date(now.getTime() + built.validityMs);
    const body = await built.sign(sequence, now, nextUpdate);
    try {
      await this.repository.publish(
        channel,
        { sequence, issuedAt: now, nextUpdate, body, contentHash: built.contentHash },
        newUuid(),
      );
    } catch (error) {
      // Another pass published this sequence first; theirs stands. Anything else is a real failure.
      // The driver wraps the database error, so its code is found on the cause chain (CLAUDE.md §6.15).
      if (!isUniqueViolation(error)) throw error;
      this.logger.warn("sandbox publication raced", { channel, sequence });
      return false;
    }
    this.logger.info("sandbox publication", { channel, sequence });
    return true;
  }

  static channels(): string[] {
    return [
      ...CRL_CHANNELS.map((c) => `crl:${c}`),
      ...STATUS_CHANNELS.map((c) => `status:${c}`),
      ...LOTE_KINDS.map((k) => `lote:${k}`),
    ];
  }

  async publishAll(): Promise<number> {
    let published = 0;
    for (const channel of SandboxPublicationService.channels()) {
      if (await this.publishIfNeeded(channel)) published += 1;
    }
    return published;
  }

  /** The background pass: at most every five minutes, since changes publish at once anyway. */
  async sweep(): Promise<void> {
    const now = this.clock.now().getTime();
    if (now - this.lastSweep < 5 * 60_000) return;
    this.lastSweep = now;
    await this.publishAll();
  }

  async latest(channel: string) {
    return this.repository.latestPublication(channel);
  }
}
