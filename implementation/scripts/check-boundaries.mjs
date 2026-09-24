#!/usr/bin/env node
/**
 * Architectural boundary check.
 *
 * Two rules the V0 plan states, enforced mechanically rather than by review discipline,
 * because both erode silently:
 *
 * 1. **Only `packages/eudiplo-adapter` may know the engine exists.** ADR 0002 Decision 2.
 *    If the engine's name or its protocol vocabulary appears anywhere else, the
 *    anti-corruption layer has already leaked.
 * 2. **The business API contains no engine contracts.** A Milestone 1 definition-of-done
 *    item. Checked against the HTTP layer specifically, because that is the customer-facing
 *    surface.
 *
 * Run by `pnpm verify`. Exits non-zero on a violation.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The adapter is the only package permitted to mention these. */
const ENGINE_TERMS = ["eudiplo", "EUDIPLO", "EudiploVerifierAdapter", "EngineClient"];

/** Protocol vocabulary that must not appear outside the adapter. */
const PROTOCOL_TERMS = [
  "dcql_query",
  "x509_hash",
  "direct_post",
  "vct_values",
  "doctype_value",
  "walletNonce",
  "openid4vp://",
  "credential_offer_uri",
];

const ADAPTER_PACKAGE = "packages/eudiplo-adapter";

/**
 * The composition root is the one place that legitimately names the concrete adapter: somebody
 * has to choose which implementation satisfies the port. Everything else sees only the port,
 * which is what makes the engine replaceable. Listing the exception explicitly keeps it a
 * deliberate, reviewable choice rather than an unnoticed hole.
 */
const COMPOSITION_ROOT = "apps/platform-api/src/composition.ts";

const SCANNED_ROOTS = ["packages", "apps"];

/** Documentation and comments may name the engine; code may not. */
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const walk = async (dir, out = []) => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
};

const violations = [];

for (const scanned of SCANNED_ROOTS) {
  for (const file of await walk(join(root, scanned))) {
    const rel = relative(root, file);
    if (rel.startsWith(ADAPTER_PACKAGE)) continue;
    const isCompositionRoot = rel === COMPOSITION_ROOT;

    const raw = await readFile(file, "utf8");
    const code = stripComments(raw);

    for (const term of ENGINE_TERMS) {
      if (!isCompositionRoot && code.includes(term)) {
        violations.push(
          `${rel}: mentions '${term}' outside ${ADAPTER_PACKAGE}. ` +
            "Only the adapter may know the protocol engine exists (ADR 0002 Decision 2).",
        );
      }
    }

    for (const term of PROTOCOL_TERMS) {
      if (code.includes(term)) {
        violations.push(
          `${rel}: mentions protocol term '${term}' outside ${ADAPTER_PACKAGE}. ` +
            "Protocol structure is produced inside the adapter, never above the ports.",
        );
      }
    }
  }
}

/**
 * The ports may name the engine only in prose. Importing from the adapter package would
 * invert the dependency direction the ports exist to establish.
 */
for (const portPackage of [
  "packages/eudi-verifier-port",
  "packages/eudi-issuer-port",
  "packages/domain",
]) {
  for (const file of await walk(join(root, portPackage))) {
    const code = await readFile(file, "utf8");
    if (/from\s+["']@edtp\/eudiplo-adapter["']/.test(code)) {
      violations.push(
        `${relative(root, file)}: imports from @edtp/eudiplo-adapter. ` +
          "Dependencies point inward: the adapter depends on the ports, never the reverse.",
      );
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(`Boundary check failed with ${violations.length} violation(s):\n`);
  for (const v of violations) process.stderr.write(`  - ${v}\n`);
  process.exit(1);
}

process.stdout.write(
  "Boundary check passed: the protocol engine is confined to packages/eudiplo-adapter.\n",
);
