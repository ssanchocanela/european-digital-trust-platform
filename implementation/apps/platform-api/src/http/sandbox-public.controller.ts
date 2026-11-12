import { PlatformError } from "@edtp/shared";
import { Controller, Get, Header, HttpCode, Inject, Param, Query, Res } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import type { Response } from "express";
import type { SandboxPublicationService } from "../modules/sandbox/publication.service.js";
import type { SandboxRegister } from "../modules/sandbox/register.js";
import type { SandboxTrustDomain } from "../modules/sandbox/trust-domain.runtime.js";
import { LOTE_FILE } from "../modules/sandbox/urls.js";
import { SANDBOX_PUBLIC } from "../tokens.js";
import { Public } from "./auth.js";

export interface SandboxPublicDependencies {
  readonly publications: SandboxPublicationService;
  readonly register: SandboxRegister;
  readonly domain: SandboxTrustDomain;
}

const CA_FILES = new Set([
  "access-ca",
  "access-ca-untrusted",
  "registrar",
  "registrar-untrusted",
  "pid-ca",
  "pid-ca-untrusted",
  "lote-signer",
  "registrar-signing",
  "registrar-untrusted-signing",
]);
const CRL_FILES = new Set(["access-ca", "access-ca-untrusted"]);
const STATUS_FILES = new Set(["registrar-signing", "registrar-untrusted-signing"]);
const LOTE_BY_FILE = new Map(Object.entries(LOTE_FILE).map(([kind, file]) => [file, kind]));

/**
 * What the sandbox publishes for anyone: trust lists, CRLs, status lists, CA certificates, the CPS
 * and the register read API. Unauthenticated by design — `EW-DM-31-003` (`TLPub_04`) — and read-only.
 * Every name is matched against a closed set, so nothing in a path reaches a file or a query.
 *
 * Off (`404` everywhere) unless the sandbox's PKI is configured.
 */
@ApiExcludeController()
@Public()
@Controller("sandbox/public")
export class SandboxPublicController {
  constructor(
    @Inject(SANDBOX_PUBLIC) private readonly deps: SandboxPublicDependencies | undefined,
  ) {}

  private on(): SandboxPublicDependencies {
    if (!this.deps) throw PlatformError.notFound("Route");
    return this.deps;
  }

  private async channel(res: Response, channel: string, type: string, binary = false) {
    const latest = await this.on().publications.latest(channel);
    if (!latest) throw PlatformError.notFound("Publication");
    res.setHeader("content-type", type);
    res.setHeader("cache-control", "public, max-age=300");
    res.send(binary ? Buffer.from(latest.body, "base64") : latest.body);
  }

  @Get("lote/:file")
  async lote(@Param("file") file: string, @Res() res: Response) {
    const kind = LOTE_BY_FILE.get(file);
    if (!kind) throw PlatformError.notFound("List");
    await this.channel(res, `lote:${kind}`, "application/jwt");
  }

  @Get("crl/:file")
  async crl(@Param("file") file: string, @Res() res: Response) {
    const ca = file.replace(/\.crl$/, "");
    if (!file.endsWith(".crl") || !CRL_FILES.has(ca)) throw PlatformError.notFound("CRL");
    await this.channel(res, `crl:${ca}`, "application/pkix-crl", true);
  }

  @Get("status/unavailable")
  @HttpCode(503)
  @Header("retry-after", "3600")
  unavailable() {
    // RC-10's target: a status list that cannot be reached, by construction.
    return {
      error: "status_list_unavailable",
      message: "This status list is deliberately unavailable (sandbox defect RC-10).",
    };
  }

  @Get("status/:key")
  async status(@Param("key") key: string, @Res() res: Response) {
    if (!STATUS_FILES.has(key)) throw PlatformError.notFound("Status list");
    await this.channel(res, `status:${key}`, "application/statuslist+jwt");
  }

  @Get("ca/:file")
  ca(@Param("file") file: string, @Res() res: Response) {
    const name = file.replace(/\.cer$/, "");
    if (!file.endsWith(".cer") || !CA_FILES.has(name))
      throw PlatformError.notFound("Certificate");
    res.setHeader("content-type", "application/pkix-cert");
    res.setHeader("cache-control", "public, max-age=3600");
    res.send(this.on().domain.certificate(name));
  }

  @Get("cps")
  @Header("content-type", "text/plain; charset=utf-8")
  cps() {
    this.on();
    return [
      "EDTP EUDI ecosystem sandbox — certification practice statement (TEST ONLY)",
      "",
      "This is a test policy for a test trust domain. Certificates issued under it identify",
      "self-declared, unverified organisations, may be deliberately defective, and must not be",
      "relied on for anything but testing. ETSI EN 319 411-1 NCP requirements are NOT met.",
      "Policy OIDs: 0.4.0.194118.1.2 (as the profile asks) and 2.25.122722476230885567871422612338706645671",
      "(this sandbox). See docs/sandbox/specification.md in the platform repository.",
    ].join("\n");
  }

  @Get("wrp")
  async wrpList(
    @Query("identifier") identifier: string | undefined,
    @Query("entitlement") entitlement: string | undefined,
    @Query("serviceidentifier") serviceIdentifier: string | undefined,
    @Res() res: Response,
  ) {
    const body = await this.on().register.list({
      ...(identifier ? { identifier: String(identifier).slice(0, 100) } : {}),
      ...(entitlement ? { entitlement: String(entitlement).slice(0, 200) } : {}),
      ...(serviceIdentifier
        ? { serviceIdentifier: String(serviceIdentifier).slice(0, 100) }
        : {}),
    });
    res.setHeader("content-type", "application/jwt");
    res.send(body);
  }

  @Get("wrp/check-intended-use")
  async check(
    @Query("identifier") identifier: string | undefined,
    @Query("serviceidentifier") serviceIdentifier: string | undefined,
    @Query("intendeduseidentifier") intendedUseIdentifier: string | undefined,
    @Res() res: Response,
  ) {
    const body = await this.on().register.checkIntendedUse({
      ...(identifier ? { identifier: String(identifier).slice(0, 100) } : {}),
      ...(serviceIdentifier
        ? { serviceIdentifier: String(serviceIdentifier).slice(0, 100) }
        : {}),
      ...(intendedUseIdentifier
        ? { intendedUseIdentifier: String(intendedUseIdentifier).slice(0, 100) }
        : {}),
    });
    res.setHeader("content-type", "application/jwt");
    res.send(body);
  }

  @Get("wrp/:identifier")
  async wrp(@Param("identifier") identifier: string, @Res() res: Response) {
    const body = await this.on().register.one(identifier.slice(0, 100));
    if (!body) throw PlatformError.notFound("Wallet-relying party");
    res.setHeader("content-type", "application/jwt");
    res.send(body);
  }

  @Get("wrp/:identifier/services/:serviceIdentifier")
  async wrpService(
    @Param("identifier") identifier: string,
    @Param("serviceIdentifier") serviceIdentifier: string,
    @Res() res: Response,
  ) {
    const body = await this.on().register.service(
      identifier.slice(0, 100),
      serviceIdentifier.slice(0, 100),
    );
    if (!body) throw PlatformError.notFound("Service");
    res.setHeader("content-type", "application/jwt");
    res.send(body);
  }
}
