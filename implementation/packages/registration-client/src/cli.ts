#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import qrcode from "qrcode-generator";
import {
  beginLogin,
  completeLogin,
  issueAccessCertificate,
  issueRegistrationCertificate,
  pollLogin,
  previewStep,
  runChain,
  STEPS,
  stepStatuses,
} from "./client.js";
import { checkEntity } from "./entity.js";
import { hashPidFingerprint, openStore, readState } from "./state.js";

/**
 * Command line for a registration session, over the same module the operator console uses.
 *
 * Two front ends, one implementation. A fourteen-call chain against a service with no idempotency
 * key is not something to implement twice: the second copy drifts, and then nothing says which of
 * the two is right. The console is the better surface for the login — it renders the QR on a screen
 * a phone can actually focus on — and this exists for the cases where a browser is in the way, and
 * so that the session is drivable over SSH.
 *
 * Nothing here prints `hash_pid`. The login stores it, mode 600, and every display of it is the
 * truncated digest from `fingerprint`.
 */

const usage = `usage: registration <command>

  login                    authenticate by PID presentation, store hash_pid
  fingerprint              print the digest of the stored hash_pid
  status                   which of the fourteen steps have run
  check <entity.json>      validate an entity file, including unfilled CHANGE-ME markers
  preview <entity.json>    print every request body, hash_pid redacted, without calling anything
  run <entity.json>        run the chain, skipping steps already recorded
  certificate              mint the PKCS#12 access certificate and the registration certificate

The service is non-production and everything it issues is TEST trust material.`;

const readEntityFile = async (path: string | undefined) => {
  if (!path) throw new Error("an entity file path is required");
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(path, "utf8");
  return checkEntity(JSON.parse(raw) as unknown);
};

const reportProblems = (check: ReturnType<typeof checkEntity>): void => {
  if (check.problems.length === 0) {
    console.info("  no problems.");
    return;
  }
  for (const problem of check.problems) {
    const marker = problem.kind === "warning" ? "warning" : "error  ";
    console.info(`  ${marker}  ${problem.path}: ${problem.message}`);
  }
};

const login = async (): Promise<void> => {
  const store = openStore();
  const existing = hashPidFingerprint(store);
  if (existing) {
    console.info(`A hash_pid is already stored (digest ${existing}).`);
    console.info(
      "Delete it, or move it aside, to authenticate again as a different registrant.",
    );
    return;
  }

  const { qrValue, presentationId } = await beginLogin();
  const qr = qrcode(0, "M");
  qr.addData(qrValue);
  qr.make();

  console.info("\nScan this with the wallet holding the test PID:\n");
  // Half-block characters, one per module: 67 columns for a 65-module code, so it fits an
  // 80-column terminal, and the half-height blocks correct for character aspect ratio. At two
  // characters per module it would be 130 wide and wrap, which breaks a QR completely.
  console.info(qr.createASCII(1, 1));
  console.info(`\nOr open this on the device:\n${qrValue}\n`);
  console.info("Waiting for the presentation. Ctrl-C to abandon it.");

  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    if (await pollLogin(presentationId)) {
      await completeLogin(presentationId);
      console.info(`\nAuthenticated. hash_pid stored at ${store.hashPidPath}, mode 600.`);
      console.info(
        `Its digest is ${hashPidFingerprint(store)} — record that, never the value.`,
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error("timed out waiting for the PID presentation");
};

const certificates = async (): Promise<void> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let passphrase = process.env["P12_PASSWORD"] ?? "";
  if (passphrase.length === 0) {
    // Not an argument, and not echoed: an argv is readable through `ps` and lands in shell
    // history. `readline` cannot mask input, so the operator is told what is about to happen.
    console.info("The passphrase will be visible as you type; clear the screen afterwards.");
    passphrase = (await rl.question("Choose a passphrase for the PKCS#12: ")).trim();
  }
  rl.close();

  const access = await issueAccessCertificate(passphrase);
  console.info(`Access certificate: ${access.path} (${access.bytes} bytes, mode 600)`);

  const registration = await issueRegistrationCertificate();
  console.info(`Registration certificate: ${registration.path}`);
  console.info(
    "\nIts encoding is unverified — documented as JAdES and COSE — so check whether it is a JWT,\n" +
      "a JSON envelope or a detached signature before importing it.",
  );
  console.info(
    `\nNext, and this is what actually closes blocker B1:\n` +
      `  ./scripts/verify-access-certificate-chain.sh ${access.path}\n` +
      "Record the matched anchor and the freshness line in docs/reference-wallet-testing.md §8.1.",
  );
};

const main = async (): Promise<void> => {
  const [command, argument] = process.argv.slice(2);

  switch (command) {
    case "login":
      await login();
      return;

    case "fingerprint": {
      const digest = hashPidFingerprint(openStore());
      console.info(digest ?? "no hash_pid stored");
      return;
    }

    case "status": {
      const state = readState(openStore());
      for (const step of stepStatuses(state)) {
        const mark = step.done ? `done  ${JSON.stringify(step.ids)}` : "pending";
        console.info(`  ${step.key.padEnd(24)} ${mark.padEnd(16)} ${step.route}`);
      }
      return;
    }

    case "check": {
      const check = await readEntityFile(argument);
      reportProblems(check);
      if (!check.runnable) process.exitCode = 1;
      return;
    }

    case "preview": {
      const check = await readEntityFile(argument);
      reportProblems(check);
      if (!check.entity) {
        process.exitCode = 1;
        return;
      }
      // A rehearsal against the real state, so the ids a step would consume are the ones it
      // actually would. Worth doing before the session: a body the service rejects at step nine
      // leaves eight entities behind that cannot be edited away.
      const state = readState(openStore());
      console.info(
        "\nBodies as they would be sent given the session's current state. A reference to an\n" +
          "entity that does not exist yet shows as an empty array, or is absent entirely — a real\n" +
          "run fills each one from the step before it.",
      );
      for (const step of STEPS) {
        console.info(`\nPOST ${step.route}`);
        console.info(
          JSON.stringify(previewStep(step, { entity: check.entity, state }), null, 2),
        );
      }
      if (!check.runnable) process.exitCode = 1;
      return;
    }

    case "run": {
      const check = await readEntityFile(argument);
      reportProblems(check);
      if (!check.entity || !check.runnable) {
        console.error("\nRefusing to run: fix the problems above first.");
        process.exitCode = 1;
        return;
      }
      await runChain(check.entity, {
        onStep: (outcome) => {
          const suffix = outcome.skipped ? "already created" : "created";
          console.info(
            `  ${outcome.label.padEnd(26)} ${suffix} ${JSON.stringify(outcome.ids)}`,
          );
        },
      });
      console.info("\nChain complete. Run `certificate` next.");
      return;
    }

    case "certificate":
      await certificates();
      return;

    default:
      console.info(usage);
      process.exitCode = command === undefined || command === "--help" ? 0 : 1;
  }
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
