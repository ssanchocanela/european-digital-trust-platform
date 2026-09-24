import { readFileSync } from "node:fs";
import { join } from "node:path";
import express, { type Request, type Response } from "express";
import { z } from "zod";
import {
  BRANDS,
  type Brand,
  type FixedClaim,
  type FormField,
  renderForm,
  renderIdentify,
  renderMessage,
  renderOpenWallet,
  renderRequest,
  renderWaiting,
} from "./page.js";

/**
 * The hosted forms — wallet-initiated issuance, for demonstrations.
 *
 * ## Where it sits
 *
 * The wallet starts an issuance from its own list of issuers and pushes an authorization request to
 * the protocol engine. The engine's authorization endpoint would mint a code at once, so the test
 * gateway sends the browser here instead, with the wallet's `request_uri`. This process asks the
 * platform which policy that request is for, and runs one of two flows:
 *
 * - **Typed form** (the PID, FNMT-styled): the person types fictitious attributes and confirms.
 * - **Identify, then request** (the representation credentials, CORPME-styled): the person presents
 *   their PID from the same wallet, comes back here, sees what the attestation will state — their
 *   identity from the PID, the representation from the policy's fixed test data — and requests it.
 *
 * Either way the platform validates, holds the values in memory and returns a pass; this process sends
 * the browser back to the engine's authorization endpoint with it, the gateway lets it through, and
 * the wallet collects the credential, whose values the engine fetches from the platform.
 *
 * ## What it can do, which is little
 *
 * - One secret: the hosted-form secret, accepted by the platform only for the policies configured
 *   for it. No tenant key, no database, no session, no cookie — state travels in the page.
 * - It cannot let a browser past the gateway by itself: the pass is signed with a secret it lacks.
 */

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** Not `PORT`, for the reason `apps/test-start` gives: one environment configures several processes. */
  PID_FORM_PORT: z.coerce.number().int().min(1).max(65_535).default(3202),
  PID_FORM_BIND_HOST: z.string().min(1).default("0.0.0.0"),
  /** The platform API, reached on the internal network. */
  PLATFORM_API_BASE_URL: z.string().url(),
  HOSTED_FORM_SECRET: z.string().min(32),
  /** Where the browser goes back to: the engine's public origin, as the wallet knows it. */
  ENGINE_PUBLIC_URL: z.string().url(),
  /** Which look each engine tenant's pages wear, as `tenant=brand` pairs: `pid-1=fnmt;rpi-1=corpme`. */
  HOSTED_FORM_BRANDS: z
    .string()
    .default("")
    .transform((v) =>
      Object.fromEntries(
        v
          .split(";")
          .map((p) => p.trim().split("="))
          .filter(
            (p): p is [string, string] => p.length === 2 && Boolean(p[0]) && Boolean(p[1]),
          ),
      ),
    ),
});

type Config = Readonly<z.infer<typeof schema>>;

const ASSETS = join(__dirname, "..", "assets");
const IMAGES = [
  "fnmt-logo.png",
  "fnmt-emblem.png",
  "corpme-logo.png",
  "corpme-emblem.png",
] as const;

const str = (source: unknown, key: string): string => {
  const value = (source as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" ? value.trim() : "";
};

/** A `request_uri` from the engine is `urn:<uuid>`; anything else did not come from a wallet's PAR. */
const REQUEST_URI = /^urn:[0-9a-f-]{36}$/i;
const TENANT = /^[A-Za-z0-9._-]{1,64}$/;
/** The identification is still under way: the wallet may return before verification finishes. */
const NON_TERMINAL = new Set([
  "CREATED",
  "REQUEST_READY",
  "AWAITING_WALLET",
  "PRESENTATION_RECEIVED",
  "VERIFYING",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const secureHeaders = (response: Response): void => {
  response.setHeader(
    "content-security-policy",
    "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  );
  response.setHeader("cache-control", "no-store");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
};

const platform = async (
  config: Config,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> => {
  const response = await fetch(new URL(path, config.PLATFORM_API_BASE_URL), {
    method,
    headers: {
      "x-edtp-form-secret": config.HOSTED_FORM_SECRET,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
};

interface Definition {
  readonly policyId: string;
  readonly flow: "form" | "identify";
  readonly credentialName: string;
  readonly fields: readonly FormField[];
  readonly fixed: readonly FixedClaim[];
}

/** The pending request's policy, and what the form must show for it. */
const definitionFor = async (
  config: Config,
  tenant: string,
  requestUri: string,
): Promise<Definition | undefined> => {
  const resolved = await platform(config, "POST", "/v1/hosted-forms/requests/resolve", {
    engineTenantRef: tenant,
    requestUri,
  });
  const policyId = str(resolved.json, "policyId");
  if (resolved.status !== 200 || !UUID.test(policyId)) return undefined;
  const { status, json } = await platform(config, "GET", `/v1/hosted-forms/${policyId}`);
  if (status !== 200) return undefined;
  const display =
    (json["credential"] as { display?: { lang: string; value: string }[] })?.display ?? [];
  return {
    policyId,
    flow: json["flow"] === "identify" ? "identify" : "form",
    credentialName:
      display.find((d) => d.lang.startsWith("es"))?.value ?? display[0]?.value ?? "credencial",
    fields: (json["fields"] as FormField[]) ?? [],
    fixed: (json["fixed"] as FixedClaim[]) ?? [],
  };
};

/**
 * The typed values as the platform takes them: dotted paths, empty boxes omitted. Nationalities are a
 * list; country codes are upper-cased, since that is the only form a PID accepts.
 */
const attributesFrom = (
  request: Request,
  fields: readonly FormField[],
): { attributes: Record<string, unknown>; values: Record<string, string> } => {
  const attributes: Record<string, unknown> = {};
  const values: Record<string, string> = {};
  for (const field of fields) {
    const raw = str(request.body, `attr:${field.path}`);
    values[field.path] = raw;
    if (raw === "") continue;
    if (field.valueType === "string[]") {
      attributes[field.path] = raw
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((v) => v.toUpperCase());
    } else if (field.valueType === "number" || field.valueType === "integer") {
      attributes[field.path] = Number(raw);
    } else if (field.path.endsWith("country")) {
      attributes[field.path] = raw.toUpperCase();
    } else {
      attributes[field.path] = raw;
    }
  }
  return { attributes, values };
};

/** The platform's refusal, in words a visitor can act on. Field names only, never values. */
const refusalMessages = (
  json: Record<string, unknown>,
  fields: readonly FormField[],
): string[] => {
  const labelOf = (path: string): string =>
    fields.find((f) => f.path === path)?.display.find((d) => d.lang.startsWith("es"))?.value ??
    path;
  const code = str(json, "error");
  if (code === "presentation_too_old")
    return ["La identificación ha caducado. Vuelva a identificarse."];
  if (code === "wallet_authorization_request_already_used")
    return ["Esta solicitud ya se ha usado. Vuelva a la cartera y empiece de nuevo."];
  const details = Array.isArray(json["details"])
    ? (json["details"] as { path?: string; code?: string; message?: string }[])
    : [];
  if (details.length === 0) return ["Revise los datos e inténtelo de nuevo."];
  return details.map((d) => {
    // The place of birth, from the schema: this provider requires its country (section 4.1 would
    // accept region or locality alone).
    if (
      String(d.path ?? "").startsWith("/place_of_birth") ||
      /place_of_birth/.test(String((d as { message?: string }).message ?? ""))
    ) {
      if (d.code === "schema_minProperties" || d.code === "schema_required")
        return "Indique el país de nacimiento, con su código de dos letras (p. ej. ES).";
    }
    if (d.code === "schema_pattern" || d.code === "schema_enum" || d.code === "schema_const")
      return `El formato no es válido: ${labelOf(
        String(d.path ?? "")
          .replace(/^\//, "")
          .replace(/\//g, "."),
      )}.`;
    const name = labelOf(
      String(d.path ?? "")
        .replace(/^\//, "")
        .replace(/\//g, "."),
    );
    if (d.code === "mandatory_claim_missing") return `Falta un dato obligatorio: ${name}.`;
    if (d.code === "claim_type_mismatch") return `El formato no es válido: ${name}.`;
    return `Revise este dato: ${name}.`;
  });
};

const main = (): void => {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    process.stderr.write(
      `Invalid environment configuration:\n${parsed.error.issues
        .map((i) => `  ${i.path.join(".")}: ${i.message}`)
        .join("\n")}\n`,
    );
    process.exit(1);
  }
  const config = parsed.data;
  const brandOf = (tenant: string): Brand =>
    BRANDS[config.HOSTED_FORM_BRANDS[tenant] ?? "fnmt"] ?? (BRANDS["fnmt"] as Brand);

  const app = express();
  app.disable("x-powered-by");
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));

  // The images, and nothing else static. The emblems are the Credential Issuers' logos in the wallet.
  for (const name of IMAGES) {
    const image = readFileSync(join(ASSETS, name));
    app.get(`/assets/${name}`, (_request, response) => {
      response.setHeader("content-type", "image/png");
      response.setHeader("cache-control", "public, max-age=86400");
      response.setHeader("x-content-type-options", "nosniff");
      response.end(image);
    });
  }

  /** The wallet's request, as carried from page to page. Validated on every hop. */
  const requestState = (source: unknown) => {
    const tenant = str(source, "tenant");
    const requestUri = str(source, "request_uri");
    const clientId = str(source, "client_id");
    if (!TENANT.test(tenant) || !REQUEST_URI.test(requestUri)) return undefined;
    return { tenant, requestUri, clientId };
  };
  const stateFields = (s: { tenant: string; requestUri: string; clientId: string }) => ({
    tenant: s.tenant,
    request_uri: s.requestUri,
    client_id: s.clientId,
  });

  const invalid = (response: Response, brand: Brand): void => {
    response
      .status(400)
      .send(
        renderMessage(
          brand,
          "Solicitud no válida",
          "Esta página se abre desde la cartera, al añadir un documento. Vuelva a la cartera e inténtelo de nuevo.",
        ),
      );
  };
  const unavailable = (response: Response, brand: Brand): void => {
    response
      .status(503)
      .send(
        renderMessage(brand, "Servicio no disponible", "Inténtelo de nuevo en unos minutos."),
      );
  };

  /** Back to the engine's authorization endpoint with the pass; the gateway lets it through. */
  const handBack = (
    response: Response,
    s: { tenant: string; requestUri: string; clientId: string },
    result: Record<string, unknown>,
  ): boolean => {
    const engineTenantRef = str(result, "engineTenantRef");
    const pass = str(result, "authorizePass");
    if (engineTenantRef !== s.tenant || !pass) return false;
    const next = new URL(
      `/issuers/${encodeURIComponent(s.tenant)}/authorize`,
      config.ENGINE_PUBLIC_URL,
    );
    if (s.clientId) next.searchParams.set("client_id", s.clientId);
    next.searchParams.set("request_uri", s.requestUri);
    next.searchParams.set("edtp_pass", pass);
    response.redirect(303, next.toString());
    return true;
  };

  app.get("/", async (request, response) => {
    secureHeaders(response);
    const s = requestState(request.query);
    const brand = brandOf(str(request.query, "tenant"));
    if (!s) return invalid(response, brand);
    const definition = await definitionFor(config, s.tenant, s.requestUri).catch(
      () => undefined,
    );
    if (!definition) return unavailable(response, brand);
    const state = { ...stateFields(s), policy: definition.policyId };
    if (definition.flow === "identify") {
      response.send(
        renderIdentify({ brand, state, credentialName: definition.credentialName }),
      );
    } else {
      response.send(renderForm({ brand, state, ...definition }));
    }
  });

  // --- typed form ---------------------------------------------------------------------------

  app.post("/confirm", async (request, response) => {
    secureHeaders(response);
    const s = requestState(request.body);
    const brand = brandOf(str(request.body, "tenant"));
    const policyId = str(request.body, "policy");
    if (!s || !UUID.test(policyId)) return invalid(response, brand);
    const definition = await definitionFor(config, s.tenant, s.requestUri).catch(
      () => undefined,
    );
    if (!definition || definition.policyId !== policyId) return unavailable(response, brand);
    const { attributes, values } = attributesFrom(request, definition.fields);
    const result = await platform(config, "POST", `/v1/hosted-forms/${policyId}/submissions`, {
      requestUri: s.requestUri,
      attributes,
    }).catch(() => undefined);
    if (result?.status === 201 && handBack(response, s, result.json)) return;
    response.status(result && result.status < 500 ? 422 : 503).send(
      renderForm({
        brand,
        state: { ...stateFields(s), policy: policyId },
        ...definition,
        values,
        errors: result
          ? refusalMessages(result.json, definition.fields)
          : ["El servicio no responde. Inténtelo de nuevo."],
      }),
    );
  });

  // --- identify, then request --------------------------------------------------------------

  app.post("/identificarse", async (request, response) => {
    secureHeaders(response);
    const s = requestState(request.body);
    const brand = brandOf(str(request.body, "tenant"));
    const policyId = str(request.body, "policy");
    if (!s || !UUID.test(policyId)) return invalid(response, brand);
    const started = await platform(
      config,
      "POST",
      `/v1/hosted-forms/${policyId}/identifications`,
      {
        engineTenantRef: s.tenant,
        requestUri: s.requestUri,
        clientId: s.clientId || undefined,
      },
    ).catch(() => undefined);
    const walletUri = str(started?.json, "walletUri");
    if (started?.status !== 201 || !walletUri) return unavailable(response, brand);
    response.send(renderOpenWallet({ brand, walletUri }));
  });

  // Where the wallet's return lands, via the platform's return route.
  app.get("/continuar", async (request, response) => {
    secureHeaders(response);
    const s = requestState(request.query);
    const brand = brandOf(str(request.query, "tenant"));
    const presentationId = str(request.query, "presentation");
    if (!s || !UUID.test(presentationId)) return invalid(response, brand);
    const definition = await definitionFor(config, s.tenant, s.requestUri).catch(
      () => undefined,
    );
    if (!definition || definition.flow !== "identify") return unavailable(response, brand);
    const identification = await platform(
      config,
      "GET",
      `/v1/hosted-forms/${definition.policyId}/identifications/${presentationId}`,
    ).catch(() => undefined);
    const status = str(identification?.json, "status");
    const state = {
      ...stateFields(s),
      policy: definition.policyId,
      presentation: presentationId,
    };
    if (status === "VERIFIED") {
      response.send(
        renderRequest({
          brand,
          state,
          credentialName: definition.credentialName,
          person: (identification?.json["claims"] as Record<string, unknown>) ?? {},
          fixed: definition.fixed,
        }),
      );
      return;
    }
    if (NON_TERMINAL.has(status)) {
      response.send(renderWaiting({ brand }));
      return;
    }
    response.status(422).send(
      renderIdentify({
        brand,
        state: { ...stateFields(s), policy: definition.policyId },
        credentialName: definition.credentialName,
        errors: ["No se ha podido verificar su identificación. Inténtelo de nuevo."],
      }),
    );
  });

  app.post("/solicitar", async (request, response) => {
    secureHeaders(response);
    const s = requestState(request.body);
    const brand = brandOf(str(request.body, "tenant"));
    const policyId = str(request.body, "policy");
    const presentationId = str(request.body, "presentation");
    if (!s || !UUID.test(policyId) || !UUID.test(presentationId))
      return invalid(response, brand);
    const result = await platform(config, "POST", `/v1/hosted-forms/${policyId}/submissions`, {
      requestUri: s.requestUri,
      presentationId,
    }).catch(() => undefined);
    if (result?.status === 201 && handBack(response, s, result.json)) return;
    response
      .status(result && result.status < 500 ? 422 : 503)
      .send(
        renderMessage(
          brand,
          "No se ha podido emitir la credencial",
          result
            ? refusalMessages(result.json, []).join(" ")
            : "El servicio no responde. Inténtelo de nuevo.",
        ),
      );
  });

  app.use((request, response) => {
    secureHeaders(response);
    response
      .status(404)
      .send(
        renderMessage(
          brandOf(str(request.query, "tenant")),
          "No encontrado",
          "Esta página no existe.",
        ),
      );
  });

  app.listen(config.PID_FORM_PORT, config.PID_FORM_BIND_HOST, () => {
    process.stdout.write(
      `${JSON.stringify({ level: "info", service: "pid-form", message: "listening", port: config.PID_FORM_PORT })}\n`,
    );
  });
};

main();
