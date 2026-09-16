#!/usr/bin/env node
/**
 * Fails when a test run reported failures, whatever exit code the runner produced.
 *
 * ## Why this exists
 *
 * `pnpm verify` is the gate everything in this repository is committed behind, and for the
 * integration suite **it did not work**. Measured on 16 September 2026 by deliberately breaking one
 * test:
 *
 *     pnpm exec vitest run --project unit          failing test -> exit 1   correct
 *     pnpm exec vitest run --project integration   failing test -> exit 0   WRONG
 *
 * The difference between the two projects is the integration suite's `globalSetup`, which boots an
 * embedded PostgreSQL. Something in that interaction loses the exit code — `embedded-postgres`
 * attaches a listener to the **parent** process's `exit` event in `initialise()`, where it plainly
 * means the spawned `initdb` child — and `pnpm run … && pnpm run …` then happily carried on. So a
 * failing integration test did not fail `verify`, and had not for as long as the suite has had a
 * global setup.
 *
 * That is worse than a flaky test: it is a green light that does not mean anything. The repository
 * has twice been committed to with `verify` failing because output was piped somewhere that
 * swallowed the status — this is the same failure with the runner playing the part of the pipe.
 *
 * ## What it does
 *
 * Reads vitest's JSON summary and exits non-zero if anything failed or if the file is missing,
 * unreadable or reports no tests at all. **Absence is a failure**: a summary that was never written
 * is indistinguishable from a run that crashed before reporting, and treating it as success would
 * rebuild the hole this closes.
 *
 *   node scripts/check-test-results.mjs <summary.json> [label]
 */

import { readFileSync } from "node:fs";

const [, , path, label = "test run"] = process.argv;

if (!path) {
  process.stderr.write("usage: node scripts/check-test-results.mjs <summary.json> [label]\n");
  process.exit(2);
}

let summary;
try {
  summary = JSON.parse(readFileSync(path, "utf8"));
} catch (error) {
  process.stderr.write(
    `${label}: could not read the result summary at ${path} — ${error.message}\n` +
      "Treating that as a failure: a run that produced no summary is not a run that passed.\n",
  );
  process.exit(1);
}

const failed = Number(summary.numFailedTests ?? 0);
const failedSuites = Number(summary.numFailedTestSuites ?? 0);
const total = Number(summary.numTotalTests ?? 0);

if (total === 0) {
  process.stderr.write(
    `${label}: the summary reports no tests at all. Either nothing ran or the run died before\n` +
      "reporting. Both are failures; a suite that runs nothing proves nothing.\n",
  );
  process.exit(1);
}

if (failed > 0 || failedSuites > 0) {
  process.stderr.write(
    `${label}: ${failed} test(s) and ${failedSuites} suite(s) failed out of ${total}.\n` +
      "The runner's own exit code is not trusted here — see the header of this script.\n",
  );
  process.exit(1);
}

process.stdout.write(`${label}: ${total} passed, none failed.\n`);
