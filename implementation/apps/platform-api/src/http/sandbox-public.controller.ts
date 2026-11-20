import { createHash } from "node:crypto";
import { CREDENTIAL_TYPE_SLUG } from "@edtp/sandbox-domain";
import { LOTE_PROFILES, SANDBOX_EAA_SERVICE_TYPE } from "@edtp/sandbox-pki";
import { PlatformError } from "@edtp/shared";
import {
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
  Query,
  Res,
} from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import type { Response } from "express";
import type { SandboxCredentialTypeService } from "../modules/sandbox/credential-types.service.js";
import type { SandboxMetadataService } from "../modules/sandbox/metadata.service.js";
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
  /** Signed metadata for sandbox issuers (S5b), when hosted issuers are configured. */
  readonly metadata?: SandboxMetadataService;
  /** EAA credential types, for their Type Metadata (ADR 0023). */
  readonly credentialTypes?: SandboxCredentialTypeService;
}

const CA_FILES = new Set([
  "access-ca",
  "access-ca-untrusted",
  "registrar",
  "registrar-untrusted",
  "pid-ca",
  "pid-ca-untrusted",
  "eaa-ca",
  "eaa-ca-untrusted",
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

  /**
   * The wallet test report signer's certificate (ADR 0022 §4), so anyone handed a signed report can
   * check it came from this sandbox unchanged. Created with the first signed report; 404 before.
   */
  @Get("ca/report-signer.cer")
  async reportSigner(@Res() res: Response) {
    const latest = await this.on().publications.latest("certificate:report-signer");
    if (!latest) throw PlatformError.notFound("Certificate");
    res.setHeader("content-type", "application/pkix-cert");
    res.setHeader("cache-control", "public, max-age=3600");
    res.send(Buffer.from(latest.body, "base64"));
  }

  @Get("ca/:file")
  ca(@Param("file") file: string, @Res() res: Response) {
    const name = file.replace(/\.cer$/, "");
    if (!file.endsWith(".cer") || !CA_FILES.has(name) || !this.on().domain.has(name))
      throw PlatformError.notFound("Certificate");
    res.setHeader("content-type", "application/pkix-cert");
    res.setHeader("cache-control", "public, max-age=3600");
    res.send(this.on().domain.certificate(name));
  }

  /**
   * A sandbox issuer's Credential Issuer metadata (ADR 0016), reached through the test gateway, which
   * sends `/.well-known/openid-credential-issuer/issuers/sbx-iss-…` here instead of to the engine.
   * Signed (`application/jwt`) when the wallet asks for it and the issuer has an access certificate;
   * the engine's JSON otherwise, unchanged.
   */
  @Get("issuer-metadata/:ref")
  async issuerMetadata(
    @Param("ref") ref: string,
    @Headers("accept") accept: string | undefined,
    @Res() res: Response,
  ) {
    const service = this.on().metadata;
    if (!service) throw PlatformError.notFound("Credential Issuer");
    const { json, jwt } = await service.metadata(ref);
    res.setHeader("cache-control", "no-store");
    res.setHeader("vary", "accept");
    if (jwt && (accept ?? "").toLowerCase().includes("application/jwt")) {
      res.setHeader("content-type", "application/jwt");
      res.send(jwt);
      return;
    }
    res.setHeader("content-type", "application/json");
    res.send(JSON.stringify(json));
  }

  /**
   * "Use your wallet with the sandbox" (ADR 0020 §6): which lists a wallet must load to trust the
   * sandbox, and the list signer's pin. The sandbox cannot configure anyone's wallet; it can say,
   * unambiguously, what to configure. Built from the request's own public base, so every URL is the
   * one this sandbox serves.
   */
  @Get("wallets")
  @Header("content-type", "text/plain; charset=utf-8")
  wallets() {
    const { domain, publications } = this.on();
    const base = publications.publicBase();
    const signer = domain.certificate("lote-signer");
    const pin = createHash("sha256").update(signer).digest("base64url");
    const list = (file: string, what: string) => `  ${base}/lote/${file}\n      ${what}`;
    return [
      "Use your wallet with the EDTP EUDI ecosystem sandbox (TEST ONLY)",
      "",
      "The sandbox is a separate test trust domain. No wallet trusts it unless it is configured to.",
      "A wallet that should work with the sandbox loads these ETSI TS 119 602 lists instead of the",
      "EU ones, for the same purposes:",
      "",
      list(
        "WRPACProviders.jwt",
        "Access CAs: which Relying Party access certificates to accept",
      ),
      list("WRPRCProviders.jwt", "Registration certificate providers"),
      list("PIDProviders.jwt", "PID Providers: which PIDs to accept"),
      list(
        "WalletProviders.jwt",
        "Wallet Providers: whose wallet attestations the sandbox's issuers accept",
      ),
      "",
      "Non-qualified EAAs (ADR 0023). There is no EU list of EAA Providers, so this one is the",
      "sandbox's own type. AS-AP-10-010 (ISSU_10) asks a wallet to validate an EAA's signature if it",
      "has access to the provider's trust anchors; this list is that access:",
      list("EAAProviders.jwt", "EAA Providers: which sandbox EAAs to accept"),
      `      LoTEType            ${LOTE_PROFILES.EAA.loteType}`,
      `      service types       ${SANDBOX_EAA_SERVICE_TYPE}/Issuance, …/Revocation`,
      `      the EAAs it covers  every vct starting ${base}/vct/`,
      "  Classify those vcts as non-qualified EAAs under one use case, and point that use case at",
      "  this list. Every sandbox EAA type has its vct under that prefix.",
      "",
      "Every list is signed (JAdES compact, x5c) by the sandbox's list signer:",
      `  ${base}/ca/lote-signer.cer`,
      `  SHA-256 of its DER, base64url: ${pin}`,
      "",
      "Wallet Providers: to have the sandbox's issuers accept your wallets, register a Wallet Provider",
      "service in the portal and upload the public certificate your wallet attestations chain to (a",
      "CA) or are signed with. The operator approves it before it reaches the list. Your attestations",
      "must carry an x5c chain; the client attestation and the key attestation are both checked.",
      "",
      "Results obtained with a wallet are that wallet's results. The sandbox makes no claim of",
      "conformance for any wallet, and its own build is a MODIFIED wallet, not the Reference Wallet.",
    ].join("\n");
  }

  /**
   * SD-JWT VC Type Metadata at a sandbox EAA's vct (ADR 0023 §2). The pinned wallet does not read it;
   * other wallets may. Both segments are matched before any lookup.
   */
  @Get("vct/:organisation/:slug")
  async vct(
    @Param("organisation") organisation: string,
    @Param("slug") slug: string,
    @Res() res: Response,
  ) {
    const types = this.on().credentialTypes;
    if (!types || !/^[a-z0-9-]{1,40}$/.test(organisation) || !CREDENTIAL_TYPE_SLUG.test(slug)) {
      throw PlatformError.notFound("Credential type");
    }
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "public, max-age=300");
    res.send(JSON.stringify(await types.metadata(organisation, slug)));
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
