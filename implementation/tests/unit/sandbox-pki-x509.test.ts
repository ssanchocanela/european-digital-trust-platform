import { execFileSync } from "node:child_process";
import { generateKeyPairSync, type KeyObject, sign, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authorityInfoAccessCaIssuers,
  authorityKeyIdentifier,
  basicConstraints,
  certificatePolicies,
  crlDistributionPoint,
  der,
  extendedKeyUsage,
  issueCertificate,
  issueCrl,
  keyUsage,
  OID,
  randomSerial,
  readCertificationRequest,
  type Signer,
  semanticsInformation,
  subjectAltName,
  subjectKeyIdentifier,
  toPem,
} from "@edtp/sandbox-pki";
import { describe, expect, it } from "vitest";

/**
 * The sandbox's hand-written DER encoder is checked against two independent parsers: Node's
 * `X509Certificate` (OpenSSL underneath, in-process) and the `openssl` command line. A wrong byte
 * must fail here, not in a wallet run.
 */

function newSigner(): Signer & { privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    publicKey,
    privateKey,
    sign: (data) => sign("sha256", data, { key: privateKey, dsaEncoding: "der" }),
  };
}

const SANDBOX_POLICY = "2.25.122722476230885567871422612338706645671";
const day = 86_400_000;
const now = new Date("2026-11-12T10:00:00Z");

function openssl(args: string[], files: Record<string, Buffer | string>): string {
  const dir = mkdtempSync(join(tmpdir(), "sbx-pki-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return execFileSync("openssl", args, {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** The offset, in the certificate's DER, of the qcStatements extension's OCTET STRING. */
function qcStatementsOffset(certificate: Buffer): string {
  const marker = der.oid(OID.qcStatements);
  const at = certificate.indexOf(marker);
  if (at < 0) throw new Error("no qcStatements extension");
  return String(at + marker.length);
}

function makeRoot(signer: Signer) {
  const name = [
    { type: OID.countryName, value: "EU" },
    { type: OID.organizationName, value: "EDTP Sandbox - TEST ONLY" },
    { type: OID.commonName, value: "EDTP Sandbox Access CA - TEST ONLY" },
  ];
  const certificate = issueCertificate(
    {
      serial: randomSerial(),
      issuer: name,
      subject: name,
      notBefore: now,
      notAfter: new Date(now.getTime() + 730 * day),
      subjectPublicKey: signer.publicKey,
      extensions: [
        basicConstraints(true, 0),
        keyUsage(["keyCertSign", "cRLSign"]),
        subjectKeyIdentifier(signer.publicKey),
      ],
    },
    signer,
  );
  return { name, certificate };
}

describe("DER primitives", () => {
  it("encodes OIDs, including a 2.25 UUID arc, and decodes them back", () => {
    for (const dotted of [
      "1.2.840.10045.4.3.2",
      "0.4.0.194118.1.2",
      SANDBOX_POLICY,
      "2.5.29.15",
    ]) {
      expect(der.decodeOid(der.decode(der.oid(dotted)))).toBe(dotted);
    }
    expect(der.oid("2.5.29.15").toString("hex")).toBe("0603551d0f");
  });

  it("encodes minimal integers and lengths", () => {
    expect(der.integer(0).toString("hex")).toBe("020100");
    expect(der.integer(128).toString("hex")).toBe("02020080");
    expect(der.unsignedInteger(Buffer.from([0, 0, 1])).toString("hex")).toBe("020101");
    expect(der.octetString(Buffer.alloc(200)).subarray(0, 3).toString("hex")).toBe("0481c8");
  });

  it("encodes KeyUsage named bits minimally", () => {
    expect(der.namedBits([0]).toString("hex")).toBe("03020780");
    expect(der.namedBits([5, 6]).toString("hex")).toBe("03020106");
  });

  it("switches from UTCTime to GeneralizedTime in 2050", () => {
    expect(der.time(new Date("2049-12-31T23:59:59Z"))[0]).toBe(der.Tag.UTC_TIME);
    expect(der.time(new Date("2050-01-01T00:00:00Z"))[0]).toBe(der.Tag.GENERALIZED_TIME);
  });

  it("refuses malformed input strictly", () => {
    expect(() => der.decode(Buffer.from("3080", "hex"))).toThrow(/indefinite/);
    expect(() => der.decode(Buffer.from("30810100", "hex"))).toThrow(/non-minimal/);
    expect(() => der.decode(Buffer.from("3005", "hex"))).toThrow(/past the input/);
    expect(() => der.decode(Buffer.from("300000", "hex"))).toThrow(/trailing/);
  });

  it("refuses a value that is not a PrintableString", () => {
    expect(() => der.printableString("é")).toThrow();
  });
});

describe("certificates", () => {
  it("issues a root that Node and openssl both accept as a self-signed CA", () => {
    const signer = newSigner();
    const { certificate } = makeRoot(signer);
    const x = new X509Certificate(certificate);
    expect(x.ca).toBe(true);
    expect(x.verify(signer.publicKey)).toBe(true);
    expect(x.subject).toContain("CN=EDTP Sandbox Access CA - TEST ONLY");
    const text = openssl(["x509", "-in", "root.pem", "-noout", "-text"], {
      "root.pem": toPem(certificate, "CERTIFICATE"),
    });
    expect(text).toContain("CA:TRUE, pathlen:0");
    expect(text).toContain("Certificate Sign, CRL Sign");
  });

  it("issues a leaf with every WRPAC extension, verified as a chain by openssl", () => {
    const ca = newSigner();
    const root = makeRoot(ca);
    const leafKey = newSigner();
    const leaf = issueCertificate(
      {
        serial: randomSerial(),
        issuer: root.name,
        subject: [
          { type: OID.countryName, value: "ES" },
          { type: OID.organizationName, value: "TEST Banco Ejemplo S.A." },
          { type: OID.organizationIdentifier, value: "SB:ES-000001" },
          { type: OID.organizationalUnitName, value: "service-1" },
          { type: OID.commonName, value: "Banco Ejemplo" },
        ],
        notBefore: now,
        notAfter: new Date(now.getTime() + 90 * day),
        subjectPublicKey: leafKey.publicKey,
        extensions: [
          basicConstraints(false),
          keyUsage(["digitalSignature"]),
          extendedKeyUsage([OID.clientAuth]),
          subjectKeyIdentifier(leafKey.publicKey),
          authorityKeyIdentifier(ca.publicKey),
          subjectAltName([
            { kind: "dns", value: "verifier.sandbox.example" },
            { kind: "uri", value: "https://banco.example/soporte" },
          ]),
          certificatePolicies([
            { policy: "0.4.0.194118.1.2", cpsUri: "https://sandbox.example/cps" },
            { policy: SANDBOX_POLICY },
          ]),
          crlDistributionPoint("https://sandbox.example/crl/access-ca.crl"),
          authorityInfoAccessCaIssuers("https://sandbox.example/ca/access-ca.cer"),
          semanticsInformation(OID.semanticsIdLegal, "https://sandbox.example/register"),
        ],
      },
      ca,
    );
    const x = new X509Certificate(leaf);
    expect(x.checkIssued(new X509Certificate(root.certificate))).toBe(true);
    expect(x.verify(ca.publicKey)).toBe(true);
    expect(x.subjectAltName).toContain("DNS:verifier.sandbox.example");
    expect(x.keyUsage).toEqual([OID.clientAuth]);

    const files = {
      "root.pem": toPem(root.certificate, "CERTIFICATE"),
      "leaf.pem": toPem(leaf, "CERTIFICATE"),
    };
    expect(
      openssl(
        [
          "verify",
          "-attime",
          String(now.getTime() / 1000 + 60),
          "-CAfile",
          "root.pem",
          "leaf.pem",
        ],
        files,
      ),
    ).toContain("leaf.pem: OK");
    const text = openssl(["x509", "-in", "leaf.pem", "-noout", "-text"], files);
    expect(text).toContain("organizationIdentifier");
    expect(text).toContain("Policy: 0.4.0.194118.1.2");
    expect(text).toContain("CPS: https://sandbox.example/cps");
    expect(text).toContain(`Policy: ${SANDBOX_POLICY}`);
    expect(text).toContain("URI:https://sandbox.example/crl/access-ca.crl");
    expect(text).toContain("CA Issuers - URI:https://sandbox.example/ca/access-ca.cer");
    expect(text).toContain("Digital Signature");
    expect(text).toContain("TLS Web Client Authentication");
    expect(text).toContain("qcStatements");
    // openssl prints qcStatements opaquely, so its inner structure is checked by parsing it.
    const parsed = openssl(
      ["asn1parse", "-in", "leaf.pem", "-strparse", qcStatementsOffset(leaf)],
      files,
    );
    expect(parsed).toContain("1.3.6.1.5.5.7.11.2");
    expect(parsed).toContain("0.4.0.194121.1.2");
    // The registration authority is a GeneralName URI, [6] IMPLICIT, whose value asn1parse omits.
    expect(parsed).toMatch(/l=\s*32 prim: cont \[ 6 \]/);
  });
});

describe("CRLs", () => {
  it("issues a CRL that openssl verifies and that lists the revoked serial", () => {
    const ca = newSigner();
    const root = makeRoot(ca);
    const serial = Buffer.from("0a1b2c3d", "hex");
    const crl = issueCrl(
      {
        issuer: root.name,
        thisUpdate: now,
        nextUpdate: new Date(now.getTime() + day),
        crlNumber: 7n,
        revoked: [{ serial, revokedAt: now }],
      },
      ca,
    );
    const text = openssl(
      ["crl", "-in", "list.crl", "-inform", "DER", "-CAfile", "root.pem", "-noout", "-text"],
      {
        "list.crl": crl,
        "root.pem": toPem(root.certificate, "CERTIFICATE"),
      },
    );
    expect(text).toContain("Serial Number: 0A1B2C3D");
    expect(text).toContain("X509v3 CRL Number:");
    expect(text).toMatch(/X509v3 CRL Number:\s*\n\s*7/);
  });

  it("issues an empty CRL without a revokedCertificates field", () => {
    const ca = newSigner();
    const root = makeRoot(ca);
    const crl = issueCrl(
      {
        issuer: root.name,
        thisUpdate: now,
        nextUpdate: new Date(now.getTime() + day),
        crlNumber: 1n,
        revoked: [],
      },
      ca,
    );
    const text = openssl(["crl", "-in", "list.crl", "-inform", "DER", "-noout", "-text"], {
      "list.crl": crl,
    });
    expect(text).toContain("No Revoked Certificates");
  });
});

describe("certification requests", () => {
  function makeCsr(curve = "prime256v1"): Buffer {
    const dir = mkdtempSync(join(tmpdir(), "sbx-csr-"));
    execFileSync("openssl", [
      "ecparam",
      "-name",
      curve,
      "-genkey",
      "-noout",
      "-out",
      join(dir, "k.pem"),
    ]);
    execFileSync("openssl", [
      "req",
      "-new",
      "-key",
      join(dir, "k.pem"),
      "-subj",
      "/CN=whatever/O=ignored",
      "-outform",
      "DER",
      "-out",
      join(dir, "r.der"),
    ]);
    return readFileSync(join(dir, "r.der"));
  }

  it("reads the public key of an openssl-made P-256 request after checking its signature", () => {
    const key = readCertificationRequest(makeCsr());
    expect(key.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
  });

  it("refuses a request whose signature does not verify", () => {
    const csr = makeCsr();
    const tampered = Buffer.from(csr);
    // Flip a byte inside the subject, which the signature covers.
    const at = tampered.indexOf(Buffer.from("whatever"));
    tampered[at] = (tampered[at] ?? 0) ^ 0x01;
    expect(() => readCertificationRequest(tampered)).toThrow(/does not verify/);
  });

  it("refuses a key on another curve", () => {
    expect(() => readCertificationRequest(makeCsr("secp384r1"))).toThrow();
  });

  it("refuses an oversized upload before parsing it", () => {
    expect(() => readCertificationRequest(Buffer.alloc(9000))).toThrow(/too large/);
  });
});

describe("serial numbers", () => {
  it("formats a serial exactly as Node's X509Certificate does, whatever its first byte", async () => {
    const { serialToHex, hexToSerial } = await import("@edtp/sandbox-pki");
    const signer = newSigner();
    const name = [{ type: OID.commonName, value: "x" }];
    for (const first of [0x00, 0x01, 0x0a, 0x0f, 0x10, 0x7f]) {
      const serial = Buffer.alloc(16, 0x11);
      serial[0] = first;
      const der = issueCertificate(
        {
          serial,
          issuer: name,
          subject: name,
          notBefore: now,
          notAfter: new Date(now.getTime() + day),
          subjectPublicKey: signer.publicKey,
          extensions: [],
        },
        signer,
      );
      const shown = new X509Certificate(der).serialNumber.toUpperCase();
      expect(serialToHex(serial), `first byte ${first}`).toBe(shown);
      expect(serialToHex(hexToSerial(shown))).toBe(shown);
    }
  });
});
