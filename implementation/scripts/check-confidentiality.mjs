#!/usr/bin/env node
/**
 * Confidentiality guard.
 *
 * The repository working tree contains an untracked `sources/` directory of reference material,
 * including internal national comitology documents. Two things must stay true:
 *
 * 1. **No file under `sources/` is ever committed**, not even accidentally via `git add -f` or a
 *    path that slips past `.gitignore`.
 * 2. **No committed file quotes or cites that material.** Naming a public instrument
 *    (a Regulation, an Implementing Regulation, an ARF section) is fine and necessary. Pointing at
 *    a local internal file, or reproducing its content, is not.
 *
 * Run by `pnpm verify`, and by the pre-commit hook against the staged set. Exits non-zero on a
 * violation.
 *
 *   node scripts/check-confidentiality.mjs            # whole tree (tracked files)
 *   node scripts/check-confidentiality.mjs --staged   # staged changes only
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const staged = process.argv.includes("--staged");

const git = (...args) =>
  execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/**
 * Subtrees of `sources/` that hold **internal** material, as opposed to public EU documents.
 *
 * The distinction matters, and scoping it wrongly makes the guard useless. `sources/` also holds
 * public instruments — the consolidated Regulation, the ARF, the Commission staff working document
 * on the European Business Wallet — which the knowledge base cites by name entirely legitimately,
 * and which the implementation prompt itself names as context. An unscoped filename scan flags
 * those and would be switched off within a week.
 *
 * Matched as path fragments, so only the directory markers appear here and no confidential document
 * title is reproduced in this file.
 */
const INTERNAL_SUBTREES = ["04 Comitology", "CCN_ENC"];

/**
 * Distinctive filename stems from the internal subtrees, read from disk rather than hard-coded, so
 * the guard tracks that directory as it changes.
 */
const internalBasenames = () => {
  const names = new Set();
  try {
    for (const path of git(
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "sources/",
    )) {
      if (!INTERNAL_SUBTREES.some((marker) => path.includes(marker))) continue;
      const base = path.split("/").pop();
      if (!base) continue;
      const stem = base.replace(/\.[^.]+$/, "");
      // Only distinctive stems: a short or generic name would match innocent prose.
      if (stem.length >= 16) names.add(stem);
    }
  } catch {
    // No sources/ directory here (a fresh clone, or CI). Nothing to protect against.
  }
  return [...names];
};

const violations = [];

// --- rule 1: nothing under sources/ is committed or staged -------------------------------

const trackedUnderSources = staged
  ? git("diff", "--cached", "--name-only").filter((p) => p.startsWith("sources/"))
  : git("ls-files", "sources/");

for (const path of trackedUnderSources) {
  violations.push(
    `${path}: a file under sources/ is ${staged ? "staged" : "tracked"}. That directory holds ` +
      "reference material including internal documents and must never be committed.",
  );
}

// --- rule 2: no committed file points at or quotes that material -------------------------

const candidates = staged
  ? git("diff", "--cached", "--name-only", "--diff-filter=ACMR")
  : git("ls-files");

const textLike = /\.(md|ts|mjs|js|json|jsonc|ya?ml|sql|sh|txt|html)$/;
const stems = internalBasenames();
const selfPath = "implementation/scripts/check-confidentiality.mjs";

for (const path of candidates) {
  if (!textLike.test(path) || path === selfPath) continue;

  let content;
  try {
    content = staged
      ? execFileSync("git", ["show", `:${path}`], {
          cwd: repoRoot,
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
        })
      : readFileSync(join(repoRoot, path), "utf8");
  } catch {
    continue;
  }

  // A path reference into the material.
  for (const match of content.matchAll(
    /(?:^|[\s"'`([<])((?:\.{0,2}\/)?sources\/[^\s"'`)\]>]+)/g,
  )) {
    violations.push(
      `${path}: references '${match[1]}'. Cite the public instrument, never a local file under ` +
        "sources/.",
    );
  }

  // A distinctive internal filename quoted in prose. Public instruments are excluded by the
  // scoping above, so a hit here is a real disclosure.
  for (const stem of stems) {
    if (content.includes(stem)) {
      violations.push(
        `${path}: names an internal document from sources/. Cite the public instrument instead.`,
      );
    }
  }

  // A directory marker for the internal subtrees, which would reveal the structure even without a
  // filename.
  for (const marker of INTERNAL_SUBTREES) {
    if (content.includes(`sources/${marker}`) || content.includes(`sources/pdf/${marker}`)) {
      violations.push(`${path}: points into the internal '${marker}' material under sources/.`);
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(
    `Confidentiality check failed with ${violations.length} violation(s):\n`,
  );
  for (const v of [...new Set(violations)]) process.stderr.write(`  - ${v}\n`);
  process.exit(1);
}

process.stdout.write(
  staged
    ? "Confidentiality check passed: nothing staged touches or cites sources/.\n"
    : "Confidentiality check passed: no tracked file touches or cites sources/.\n",
);
