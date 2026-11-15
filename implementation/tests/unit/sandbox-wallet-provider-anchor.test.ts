import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  basicConstraints,
  inspectWalletProviderAnchor,
  issueCertificate,
  keyUsage,
  LOTE_PROFILES,
  OID,
  randomSerial,
  toPem,
} from "@edtp/sandbox-pki";
import { describe, expect, it } from "vitest";

/** The check on an uploaded Wallet Provider certificate (ADR 0020 §2), and the fourth list's type. */
const NOW = new Date("2026-11-15T10:00:00Z");
const DAY = 86_400_000;

function certificate(
  options: {
    ca?: boolean;
    usage?: Parameters<typeof keyUsage>[0];
    from?: Date;
    to?: Date;
  } = {},
) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const name = [{ type: OID.commonName, value: "Test Wallet Provider CA" }];
  const der = issueCertificate(
    {
      serial: randomSerial(),
      issuer: name,
      subject: name,
      notBefore: options.from ?? new Date(NOW.getTime() - DAY),
      notAfter: options.to ?? new Date(NOW.getTime() + 365 * DAY),
      subjectPublicKey: publicKey,
      extensions: [
        basicConstraints(options.ca ?? true),
        keyUsage(
          options.usage ??
            (options.ca === false ? ["digitalSignature"] : ["keyCertSign", "cRLSign"]),
        ),
      ],
    },
    {
      publicKey,
      sign: (d) => sign("sha256", d, { key: privateKey, dsaEncoding: "der" }),
    },
  );
  return { pem: toPem(der, "CERTIFICATE"), privateKey };
}

/** RSA, which the sandbox's own encoder does not produce: made with openssl. */
function rsaCa(bits: number): string {
  const dir = mkdtempSync(join(tmpdir(), "wp-rsa-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      `rsa:${bits}`,
      "-nodes",
      "-keyout",
      join(dir, "k.pem"),
      "-out",
      join(dir, "c.pem"),
      "-days",
      "365",
      "-subj",
      "/CN=RSA Wallet Provider CA",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
    ],
    { stdio: "ignore" },
  );
  return readFileSync(join(dir, "c.pem"), "utf8");
}

const refusal = (input: string) => {
  const r = inspectWalletProviderAnchor(input, NOW);
  return r.ok ? "accepted" : r.refusal;
};

describe("an uploaded Wallet Provider certificate (ADR 0020 §2)", () => {
  it("accepts a CA, and reports it as one, with its SHA-256 fingerprint", () => {
    const r = inspectWalletProviderAnchor(certificate().pem, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.anchor.kind).toBe("ca");
    expect(r.anchor.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(r.anchor.subject).toContain("Test Wallet Provider CA");
  });

  it("accepts a single signing certificate, which the engine matches as the pinned leaf (A36)", () => {
    const r = inspectWalletProviderAnchor(certificate({ ca: false }).pem, NOW);
    expect(r.ok && r.anchor.kind).toBe("signer");
  });

  it("refuses anything that contains a private key, before parsing it", () => {
    const { pem, privateKey } = certificate();
    const key = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    expect(refusal(`${pem}\n${key}`)).toBe("contains_private_key");
    expect(refusal(key)).toBe("contains_private_key");
  });

  it.each([
    [
      "two certificates",
      () => `${certificate().pem}${certificate().pem}`,
      "not_one_certificate",
    ],
    ["no certificate", () => "hello", "not_one_certificate"],
    ["an expired one", () => certificate({ to: new Date(NOW.getTime() - DAY) }).pem, "expired"],
    [
      "one not yet valid",
      () => certificate({ from: new Date(NOW.getTime() + DAY) }).pem,
      "not_yet_valid",
    ],
    [
      "one valid for over 20 years",
      () => certificate({ to: new Date(NOW.getTime() + 25 * 366 * DAY) }).pem,
      "validity_too_long",
    ],
    // OpenSSL, and so Node, does not count CA:TRUE without keyCertSign as a CA: it is then checked
    // as a signer, and refused for want of digitalSignature.
    [
      "a CA that cannot sign certificates",
      () => certificate({ usage: ["cRLSign"] }).pem,
      "leaf_without_digital_signature",
    ],
    [
      "a signer that cannot sign",
      () => certificate({ ca: false, usage: ["keyEncipherment"] }).pem,
      "leaf_without_digital_signature",
    ],
  ])("refuses %s", (_name, make, expected) => {
    expect(refusal(make())).toBe(expected);
  });

  it("refuses RSA 2048", () => {
    // Made now by openssl, so checked against the present, not the fixed test date.
    const r = inspectWalletProviderAnchor(rsaCa(2048), new Date());
    expect(r.ok ? "accepted" : r.refusal).toBe("unsupported_key");
  });

  it("accepts RSA 3072", () => {
    const r = inspectWalletProviderAnchor(rsaCa(3072), new Date());
    expect(r.ok && r.anchor.kind).toBe("ca");
  });
});

describe("the Wallet Providers list type", () => {
  it("carries the notified EU list's identifiers, and the service type the engine matches", () => {
    const p = LOTE_PROFILES.WalletProviders;
    expect(p.loteType).toBe("http://uri.etsi.org/19602/LoTEType/EUWalletProvidersList");
    expect(p.statusDetermination).toBe(
      "http://uri.etsi.org/19602/WalletProvidersList/StatusDetn/EU",
    );
    expect(p.schemeRules).toBe("http://uri.etsi.org/19602/WalletProvidersList/schemerules/EU");
    expect(p.serviceType).toBe("http://uri.etsi.org/19602/SvcType/WalletSolution");
  });
});
