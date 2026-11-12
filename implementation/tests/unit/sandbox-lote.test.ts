import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildLote,
  createTrustDomain,
  decodeCompactJws,
  FileKeyStore,
  type IssuedMember,
  LOTE_PROFILES,
  type LoteInput,
  signLote,
  verifyEs256,
} from "@edtp/sandbox-pki";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The sandbox's LoTEs (specification §7.3). The decisive property is structural: a list whose shape
 * differs from the notified lists' was refused by the wallet's parser before (`make-test-lote.mjs`),
 * so each list is compared, key for key and type for type, with the shape of the notified list of
 * its kind as published on 12 November 2026 (`tests/fixtures/lote/*.shape.json`, values stripped).
 */
const now = new Date("2026-11-12T10:00:00Z");
let base: Omit<LoteInput, "kind">;
let domain: Map<string, IssuedMember>;

const shape = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.length
      ? [shape(v[0])]
      : []
    : v !== null && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v as object)
            .map(([k, x]) => [k, shape(x)])
            .sort(([a], [b]) => (String(a) < String(b) ? -1 : 1)),
        )
      : typeof v === "number"
        ? "int"
        : typeof v === "string"
          ? "str"
          : typeof v;

beforeAll(async () => {
  const store = new FileKeyStore(mkdtempSync(join(tmpdir(), "sbx-lote-")), Buffer.alloc(32, 2));
  domain = new Map((await createTrustDomain(store, now)).map((i) => [i.member.name, i]));
  base = {
    sequenceNumber: 1,
    issuedAt: now,
    nextUpdate: new Date(now.getTime() + 7 * 86_400_000),
    publicationUrl: "https://sandbox.test/lote/X.jwt",
    informationUrl: "https://sandbox.test/lote",
    operatorEmail: "operator@sandbox.test",
    entities: [
      {
        name: "EDTP Sandbox — TEST ONLY",
        tradeName: "EDTP Sandbox",
        informationUri: "https://sandbox.test",
        email: "operator@sandbox.test",
        anchors: [
          {
            serviceName: "EDTP Sandbox CA - TEST ONLY",
            certificate: (domain.get("access-ca") as IssuedMember).certificate,
          },
        ],
      },
    ],
    signer: await store.signer("lote-signer"),
    signerCertificate: (domain.get("lote-signer") as IssuedMember).certificate,
  };
});

const fixtures = {
  WRPAC: "WRPACProviders",
  WRPRC: "WRPRCProviders",
  PID: "PIDProviders",
} as const;

describe("buildLote", () => {
  for (const kind of ["WRPAC", "WRPRC", "PID"] as const) {
    it(`gives a ${kind} list exactly the notified list's shape`, () => {
      const notified = JSON.parse(
        readFileSync(
          join(__dirname, "..", "fixtures", "lote", `${fixtures[kind]}.shape.json`),
          "utf8",
        ),
      );
      const ours = shape(buildLote({ ...base, kind }));
      const normalise = (v: unknown) =>
        JSON.stringify(v).replaceAll('"int"', '"N"').replaceAll('"str"', '"S"');
      const theirs = JSON.parse(
        JSON.stringify(notified).replaceAll('"int"', '"N"').replaceAll('"str"', '"S"'),
      );
      expect(normalise(ours)).toBe(JSON.stringify(theirs));
    });
  }

  it("names the sandbox as operator and says it is not a notified list", () => {
    const lote = buildLote({ ...base, kind: "PID" }) as {
      LoTE: { ListAndSchemeInformation: Record<string, unknown> };
    };
    const info = lote.LoTE.ListAndSchemeInformation;
    expect(JSON.stringify(info.SchemeOperatorName)).toContain("TEST ONLY");
    expect(JSON.stringify(info.SchemeName)).toContain("NOT a notified list");
    expect(info.LoTEType).toBe(LOTE_PROFILES.PID.loteType);
  });

  it("refuses a sequence number below 1 and a NextUpdate more than six months ahead", () => {
    expect(() => buildLote({ ...base, kind: "PID", sequenceNumber: 0 })).toThrow(/starts at 1/);
    expect(() =>
      buildLote({
        ...base,
        kind: "PID",
        nextUpdate: new Date(now.getTime() + 200 * 86_400_000),
      }),
    ).toThrow(/6 months/);
  });
});

describe("signLote", () => {
  it("signs with the LoTE signer, its certificate in x5c, iat and no sigT", () => {
    const jws = decodeCompactJws(signLote({ ...base, kind: "WRPAC" }));
    expect(jws.header).toMatchObject({
      alg: "ES256",
      typ: "JOSE+JSON",
      iat: Math.floor(now.getTime() / 1000),
    });
    expect(jws.header.sigT).toBeUndefined();
    expect(jws.header.crit).toBeUndefined();
    const signer = new X509Certificate(
      Buffer.from((jws.header.x5c as string[])[0] as string, "base64"),
    );
    expect(verifyEs256(jws, signer.publicKey)).toBe(true);
    expect(signer.subject).toContain("LoTE Signer");
  });
});
