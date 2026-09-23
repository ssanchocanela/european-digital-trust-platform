import { readFileSync } from "node:fs";
import { join } from "node:path";
import express, { type Request, type Response } from "express";
import { z } from "zod";
import { type FormField, renderForm, renderMessage } from "./page.js";

/**
 * The hosted PID form — wallet-initiated issuance, for a demonstration.
 *
 * ## Where it sits
 *
 * The wallet starts an issuance from its own list of issuers and pushes an authorization request to
 * the protocol engine. The engine's authorization endpoint would mint a code at once, so the test
 * gateway sends the browser here instead, with the wallet's `request_uri`. The person types their
 * (fictitious) PID attributes and confirms; this process submits them to the platform, which
 * validates them against the credential type exactly as an operator-form issuance would, holds them
 * in memory, and returns a pass. This process then sends the browser on to the engine's authorization
 * endpoint with that pass, the gateway lets it through, the engine sends the browser back to the
 * wallet, and the wallet collects the credential — whose values the engine fetches from the platform.
 *
 * ## What it can do, which is little
 *
 * - One secret: the hosted-form secret, which the platform accepts only for the policies configured
 *   for it. No tenant key, no database, no session, no cookie.
 * - It keeps nothing. Values pass through one request and on to the platform.
 * - It cannot let a browser past the gateway by itself: the pass is signed with a secret it does not
 *   hold.
 */

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** Not `PORT`, for the reason `apps/test-start` gives: one environment configures several processes. */
  PID_FORM_PORT: z.coerce.number().int().min(1).max(65_535).default(3202),
  PID_FORM_BIND_HOST: z.string().min(1).default("0.0.0.0"),
  /** The platform API, reached on the internal network. */
  PLATFORM_API_BASE_URL: z.string().url(),
  HOSTED_FORM_SECRET: z.string().min(32),
  /** The issuance policy this form issues under. The platform must have it in HOSTED_FORM_POLICIES. */
  PID_FORM_POLICY_ID: z.string().uuid(),
  /** Where the browser goes back to: the engine's public origin, as the wallet knows it. */
  ENGINE_PUBLIC_URL: z.string().url(),
});

type Config = Readonly<z.infer<typeof schema>>;

const ASSETS = join(__dirname, "..", "assets");
const asset = (name: string): Buffer => readFileSync(join(ASSETS, name));

const queryString = (request: Request, key: string): string => {
  const value = (request.query as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
};

const bodyString = (request: Request, key: string): string => {
  const value = (request.body as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" ? value.trim() : "";
};

/** A `request_uri` from the engine is `urn:<uuid>`; anything else did not come from a wallet's PAR. */
const REQUEST_URI = /^urn:[0-9a-f-]{36}$/i;
const TENANT = /^[A-Za-z0-9._-]{1,64}$/;

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
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
};

interface FormDefinition {
  readonly credentialName: string;
  readonly fields: readonly FormField[];
}

const loadDefinition = async (config: Config): Promise<FormDefinition> => {
  const { status, json } = await platform(
    config,
    "GET",
    `/v1/hosted-forms/${config.PID_FORM_POLICY_ID}`,
  );
  if (status !== 200) throw new Error(`form definition unavailable (${status})`);
  const display =
    (json["credential"] as { display?: { lang: string; value: string }[] })?.display ?? [];
  return {
    credentialName:
      display.find((d) => d.lang.startsWith("es"))?.value ?? display[0]?.value ?? "PID",
    fields: (json["fields"] as FormField[]) ?? [],
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
    const raw = bodyString(request, `attr:${field.path}`);
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
  const details = Array.isArray(json["details"])
    ? (json["details"] as { path?: string; code?: string }[])
    : [];
  if (details.length === 0) return ["Revise los datos e inténtelo de nuevo."];
  return details.map((d) => {
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
  const logo = asset("fnmt-logo.png");
  const emblem = asset("fnmt-emblem.png");

  const app = express();
  app.disable("x-powered-by");
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));

  // The two images, and nothing else static. The emblem is the Credential Issuer's logo in the wallet.
  for (const [path, image] of [
    ["/assets/fnmt-logo.png", logo],
    ["/assets/fnmt-emblem.png", emblem],
  ] as const) {
    app.get(path, (_request, response) => {
      response.setHeader("content-type", "image/png");
      response.setHeader("cache-control", "public, max-age=86400");
      response.setHeader("x-content-type-options", "nosniff");
      response.end(image);
    });
  }

  app.get("/", async (request, response) => {
    secureHeaders(response);
    const tenant = queryString(request, "tenant");
    const requestUri = queryString(request, "request_uri");
    if (!TENANT.test(tenant) || !REQUEST_URI.test(requestUri)) {
      response
        .status(400)
        .send(
          renderMessage(
            "Solicitud no válida",
            "Esta página se abre desde la cartera, al añadir un PID. Vuelva a la cartera e inténtelo de nuevo.",
          ),
        );
      return;
    }
    try {
      const definition = await loadDefinition(config);
      response.send(
        renderForm({
          tenant,
          requestUri,
          clientId: queryString(request, "client_id"),
          ...definition,
        }),
      );
    } catch {
      response
        .status(503)
        .send(renderMessage("Servicio no disponible", "Inténtelo de nuevo en unos minutos."));
    }
  });

  app.post("/confirm", async (request, response) => {
    secureHeaders(response);
    const tenant = bodyString(request, "tenant");
    const requestUri = bodyString(request, "request_uri");
    const clientId = bodyString(request, "client_id");
    if (!TENANT.test(tenant) || !REQUEST_URI.test(requestUri)) {
      response.status(400).send(renderMessage("Solicitud no válida", "Vuelva a la cartera."));
      return;
    }
    let definition: FormDefinition;
    try {
      definition = await loadDefinition(config);
    } catch {
      response
        .status(503)
        .send(renderMessage("Servicio no disponible", "Inténtelo de nuevo en unos minutos."));
      return;
    }
    const { attributes, values } = attributesFrom(request, definition.fields);
    const result = await platform(
      config,
      "POST",
      `/v1/hosted-forms/${config.PID_FORM_POLICY_ID}/submissions`,
      { requestUri, attributes },
    ).catch(() => undefined);

    if (!result || result.status !== 201) {
      const status = result?.status ?? 503;
      response.status(status >= 500 ? 503 : 422).send(
        renderForm({
          tenant,
          requestUri,
          clientId,
          ...definition,
          values,
          errors:
            status === 409
              ? ["Esta solicitud ya se ha usado. Vuelva a la cartera y empiece de nuevo."]
              : result
                ? refusalMessages(result.json, definition.fields)
                : ["El servicio no responde. Inténtelo de nuevo."],
        }),
      );
      return;
    }

    const engineTenantRef = String(result.json["engineTenantRef"] ?? "");
    const pass = String(result.json["authorizePass"] ?? "");
    if (engineTenantRef !== tenant || !pass) {
      response
        .status(502)
        .send(renderMessage("Error", "La respuesta del servicio no es coherente."));
      return;
    }
    // On to the engine's authorization endpoint, which the gateway now lets through, and from there
    // back to the wallet.
    const next = new URL(
      `/issuers/${encodeURIComponent(tenant)}/authorize`,
      config.ENGINE_PUBLIC_URL,
    );
    if (clientId) next.searchParams.set("client_id", clientId);
    next.searchParams.set("request_uri", requestUri);
    next.searchParams.set("edtp_pass", pass);
    response.redirect(303, next.toString());
  });

  app.use((_request, response) => {
    secureHeaders(response);
    response.status(404).send(renderMessage("No encontrado", "Esta página no existe."));
  });

  app.listen(config.PID_FORM_PORT, config.PID_FORM_BIND_HOST, () => {
    process.stdout.write(
      `${JSON.stringify({ level: "info", service: "pid-form", message: "listening", port: config.PID_FORM_PORT })}\n`,
    );
  });
};

main();
