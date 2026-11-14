import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxApi } from "@edtp/sandbox-portal/api.js";
import { createApp } from "@edtp/sandbox-portal/app.js";
import { readWalletOffer } from "@edtp/sandbox-portal/wallet.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** The sandbox wallet download and the Access lock on the portal (S6, ADR 0017). */
const api: SandboxApi = { call: async () => ({ status: 404, body: {} }) };
const APK = Buffer.from("not really an apk");
const SHA = createHash("sha256").update(APK).digest("hex");

let dir: string;
let close: (() => void) | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sbx-wallet-"));
});
afterEach(() => {
  close?.();
  close = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const build = (over: Record<string, unknown> = {}) => ({
  file: "edtp-sandbox-wallet-1.apk",
  sha256: SHA,
  profile: "sandbox-strict",
  deviations: "wd-3,wd-4,wd-6,wd-7,wd-8",
  buildType: "release",
  builtAt: "2026-11-12",
  notice: "edtp-sandbox-wallet-1.notice.txt",
  ...over,
});

function place(manifest: unknown) {
  writeFileSync(join(dir, "edtp-sandbox-wallet-1.apk"), APK);
  writeFileSync(
    join(dir, "edtp-sandbox-wallet-1.notice.txt"),
    "EUPL 1.2 notices; modified build.",
  );
  writeFileSync(join(dir, "wallet.json"), JSON.stringify(manifest));
}

async function serve(options: { requireAccess?: boolean; walletDir?: string }) {
  const app = createApp({ publicUrl: "https://portal.test", api, ...options });
  const server = app.listen(0);
  close = () => server.close();
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return (path: string, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { redirect: "manual", headers });
}

describe("what is offered", () => {
  it("offers nothing before the EUPL reading is confirmed", () => {
    place({ builds: [build()] });
    expect(readWalletOffer(dir)).toMatchObject({ state: "none" });
  });

  it("offers a release build whose file hashes as listed, with its notice", () => {
    place({ legalConfirmed: "2026-11-20", builds: [build()] });
    const offer = readWalletOffer(dir);
    expect(offer.state).toBe("offered");
    if (offer.state === "offered")
      expect(offer.builds.map((b) => b.file)).toEqual([build().file]);
  });

  it("refuses a debug build, a hash mismatch and a missing notice", () => {
    for (const bad of [
      build({ buildType: "debug" }),
      build({ sha256: "0".repeat(64) }),
      build({ notice: "absent.notice.txt" }),
    ]) {
      place({ legalConfirmed: "2026-11-20", builds: [bad] });
      expect(readWalletOffer(dir)).toMatchObject({ state: "none" });
    }
  });

  it("refuses a file name that leaves the directory", () => {
    place({ legalConfirmed: "2026-11-20", builds: [build({ file: "../etc/passwd.apk" })] });
    expect(readWalletOffer(dir)).toMatchObject({ state: "none" });
  });
});

describe("the portal", () => {
  it("refuses every request without Cloudflare Access's assertion when required", async () => {
    const get = await serve({ requireAccess: true, walletDir: dir });
    expect((await get("/")).status).toBe(403);
    expect((await get("/wallet")).status).toBe(403);
    expect((await get("/style.css")).status).toBe(403);
    // The unsigned e-mail header alone is not enough (ADR 0018 Decision 1).
    expect(
      (await get("/wallet", { "cf-access-authenticated-user-email": "op@example.test" }))
        .status,
    ).toBe(403);
    expect((await get("/wallet", { "cf-access-jwt-assertion": "a.b.c" })).status).toBe(200);
  });

  it("serves only a listed file, and says what the build is", async () => {
    place({ legalConfirmed: "2026-11-20", builds: [build()] });
    const get = await serve({ walletDir: dir });
    const page = await (await get("/wallet")).text();
    expect(page).toContain("modified");
    expect(page).toContain("EUPL 1.2");
    expect(page).toContain(SHA);
    expect(page).toContain("tools/test-wallet");
    const apk = await get("/wallet/edtp-sandbox-wallet-1.apk");
    expect(apk.status).toBe(200);
    expect(apk.headers.get("content-type")).toBe("application/vnd.android.package-archive");
    expect(Buffer.from(await apk.arrayBuffer())).toEqual(APK);
    expect((await get("/wallet/wallet.json")).status).toBe(404);
    expect((await get("/wallet/..%2Fwallet.json")).status).toBe(404);
  });

  it("says the build is not published when nothing is offered", async () => {
    const get = await serve({});
    const page = await (await get("/wallet")).text();
    expect(page).toContain("No wallet build");
  });
});
