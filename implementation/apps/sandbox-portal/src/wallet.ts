import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * The sandbox wallet build, offered for download behind Cloudflare Access (ADR 0017, CLAUDE.md §6.22).
 *
 * The portal serves only what an operator placed in the wallet directory and listed in its
 * `wallet.json`:
 *
 *   { "legalConfirmed": "<date the EUPL reading was confirmed>",
 *     "builds": [{ "file": "edtp-sandbox-wallet-….apk", "sha256": "…", "profile": "sandbox",
 *                  "deviations": "wd-2,wd-3,…", "buildType": "release", "builtAt": "…",
 *                  "notice": "edtp-sandbox-wallet-….notice.txt" }] }
 *
 * Refused, and so not offered:
 * - a manifest without `legalConfirmed` (ADR 0010 §4: legal confirmation of the EUPL reading comes
 *   before the first upload);
 * - a build that is not `release`, because a debug build logs HTTP bodies, which include PID contents;
 * - a build whose file does not hash to the listed SHA-256;
 * - a build without its notice: the EUPL 1.2 notices and the statement that it is modified, and how.
 *
 * Nothing is read outside the directory: file names are plain names, checked by pattern.
 */
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

const manifestSchema = z.object({
  legalConfirmed: z.string().min(1).optional(),
  builds: z
    .array(
      z.object({
        file: z.string().regex(FILE).endsWith(".apk"),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        profile: z.enum(["sandbox", "sandbox-strict"]),
        deviations: z.string().max(200),
        buildType: z.string(),
        builtAt: z.string().max(40),
        notice: z.string().regex(FILE).endsWith(".txt"),
      }),
    )
    .max(4),
});

export interface WalletBuild {
  readonly file: string;
  readonly sha256: string;
  readonly profile: "sandbox" | "sandbox-strict";
  readonly deviations: string;
  readonly builtAt: string;
  readonly notice: string;
}

export type WalletOffer =
  | { readonly state: "none"; readonly reason: string }
  | {
      readonly state: "offered";
      readonly builds: readonly WalletBuild[];
      readonly refused: number;
    };

const hashCache = new Map<string, { key: string; sha256: string }>();

function sha256Of(path: string): string {
  const stat = statSync(path);
  const key = `${stat.size}:${stat.mtimeMs}`;
  const cached = hashCache.get(path);
  if (cached?.key === key) return cached.sha256;
  const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  hashCache.set(path, { key, sha256 });
  return sha256;
}

export function readWalletOffer(dir: string | undefined): WalletOffer {
  if (!dir) return { state: "none", reason: "No wallet build is offered here." };
  let manifest: z.infer<typeof manifestSchema>;
  try {
    manifest = manifestSchema.parse(JSON.parse(readFileSync(join(dir, "wallet.json"), "utf8")));
  } catch {
    return { state: "none", reason: "No wallet build has been published yet." };
  }
  if (!manifest.legalConfirmed) {
    return {
      state: "none",
      reason:
        "Not yet published: the build is offered only after legal confirmation of the EUPL 1.2 reading.",
    };
  }
  const builds: WalletBuild[] = [];
  let refused = 0;
  for (const b of manifest.builds) {
    try {
      if (b.buildType !== "release") throw new Error("not a release build");
      if (sha256Of(join(dir, b.file)) !== b.sha256) throw new Error("hash mismatch");
      statSync(join(dir, b.notice));
      builds.push({
        file: b.file,
        sha256: b.sha256,
        profile: b.profile,
        deviations: b.deviations,
        builtAt: b.builtAt,
        notice: b.notice,
      });
    } catch {
      refused++;
    }
  }
  if (builds.length === 0) return { state: "none", reason: "No wallet build is offered here." };
  return { state: "offered", builds, refused };
}

/** The file to send, only when the current offer lists it. */
export function offeredFile(
  dir: string | undefined,
  name: string,
): { path: string; kind: "apk" | "notice" } | undefined {
  if (!dir || !FILE.test(name)) return undefined;
  const offer = readWalletOffer(dir);
  if (offer.state !== "offered") return undefined;
  if (offer.builds.some((b) => b.file === name)) return { path: join(dir, name), kind: "apk" };
  if (offer.builds.some((b) => b.notice === name))
    return { path: join(dir, name), kind: "notice" };
  return undefined;
}

export const openFile = (path: string) => createReadStream(path);
