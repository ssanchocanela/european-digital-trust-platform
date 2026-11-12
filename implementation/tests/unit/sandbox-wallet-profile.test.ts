import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** The test wallet's sandbox profile (S4): a named set of existing flags, nothing more. */
const script = join(__dirname, "..", "..", "tools", "test-wallet", "build.sh");
const run = (...args: string[]) =>
  spawnSync("bash", [script, ...args, "--show-config"], { encoding: "utf8" });

describe("build.sh --profile sandbox", () => {
  it("expands to the three sandbox lists, the deviations they need, and its own identity", () => {
    const out = execFileSync(
      "bash",
      [
        script,
        "--profile",
        "sandbox",
        "--sandbox-base",
        "https://sbx.test/sandbox/public/",
        "--show-config",
      ],
      {
        encoding: "utf8",
      },
    );
    expect(out).toContain("deviations=wd-2,wd-3,wd-4,wd-6,wd-7,wd-8");
    expect(out).toContain("wrpac_lote=https://sbx.test/sandbox/public/lote/WRPACProviders.jwt");
    expect(out).toContain("pid_lote=https://sbx.test/sandbox/public/lote/PIDProviders.jwt");
    expect(out).toContain("wrprc_lote=https://sbx.test/sandbox/public/lote/WRPRCProviders.jwt");
    expect(out).toContain("app_id_suffix=.sandbox");
    expect(out).toContain("app_name=EDTP Sandbox wallet");
  });

  it("refuses half a profile: no base, a cleartext base, or its own flags given again", () => {
    expect(run("--profile", "sandbox").status).not.toBe(0);
    expect(run("--profile", "sandbox", "--sandbox-base", "http://sbx.test").status).not.toBe(0);
    expect(
      run("--profile", "sandbox", "--sandbox-base", "https://sbx.test", "--deviations", "wd-3")
        .status,
    ).not.toBe(0);
    expect(
      run(
        "--profile",
        "sandbox",
        "--sandbox-base",
        "https://sbx.test",
        "--pid-lote",
        "https://x",
      ).status,
    ).not.toBe(0);
    expect(run("--sandbox-base", "https://sbx.test").status).not.toBe(0);
    expect(run("--profile", "other").status).not.toBe(0);
  });

  it("has a strict profile without wd-2, with its own identity", () => {
    const out = execFileSync(
      "bash",
      [
        script,
        "--profile",
        "sandbox-strict",
        "--sandbox-base",
        "https://sbx.test/sandbox/public",
        "--show-config",
      ],
      {
        encoding: "utf8",
      },
    );
    expect(out).toContain("deviations=wd-3,wd-4,wd-6,wd-7,wd-8");
    expect(out).not.toContain("wd-2");
    expect(out).toContain("app_id_suffix=.sandboxstrict");
  });
});
