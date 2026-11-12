import type { ListKind } from "@edtp/sandbox-pki";

/**
 * Every public address of the sandbox, from one base (`SANDBOX_PUBLIC_BASE_URL`). Certificates and
 * lists embed these, so they are built in one place: a CRL distribution point that disagrees with the
 * route serving the CRL would be a defect nobody chose.
 */
export interface SandboxUrls {
  readonly base: string;
  readonly information: string;
  readonly cps: string;
  readonly register: string;
  crl(ca: string): string;
  caCertificate(ca: string): string;
  statusList(signingKey: string): string;
  readonly unavailableStatus: string;
  lote(kind: ListKind): string;
  registryEntry(localIdentifier: string): string;
}

export const LOTE_FILE: Readonly<Record<ListKind, string>> = {
  PID: "PIDProviders.jwt",
  WRPAC: "WRPACProviders.jwt",
  WRPRC: "WRPRCProviders.jwt",
};

export function sandboxUrls(base: string): SandboxUrls {
  const root = base.replace(/\/+$/, "");
  return {
    base: root,
    information: `${root}/`,
    cps: `${root}/cps`,
    register: `${root}/wrp`,
    crl: (ca) => `${root}/crl/${ca}.crl`,
    caCertificate: (ca) => `${root}/ca/${ca}.cer`,
    statusList: (key) => `${root}/status/${key}`,
    unavailableStatus: `${root}/status/unavailable`,
    lote: (kind) => `${root}/lote/${LOTE_FILE[kind]}`,
    registryEntry: (id) => `${root}/wrp/${encodeURIComponent(id)}`,
  };
}
