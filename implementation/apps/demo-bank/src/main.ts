import express, { type Response } from "express";
import { z } from "zod";
import {
  type CredentialChoice,
  renderFailure,
  renderHome,
  renderOpenWallet,
  renderSuccess,
  renderWaiting,
} from "./page.js";

/**
 * The demonstration bank — a Relying Party page for exercising the representation credentials.
 *
 * A person chooses which credential to present — Power of Representation, Power of Attorney or
 * Employee Authorisation — and their wallet opens on the same device. The wallet presents, the
 * platform verifies (issuer signature against the TEST EAA list, validity, status), and the wallet's
 * return leads back here, where the outcome is shown. Presenting again is the same path, which is how
 * a credential's reuse is tested.
 *
 * ## What it can do, which is little
 *
 * - One secret: the hosted-verifier secret, which the platform accepts only for the presentation
 *   policies configured for it. No tenant key, no database, no session, no cookie.
 * - It never chooses where the wallet returns: the platform sets that from its own configuration.
 * - It shows the verified claims to the person who presented them, and keeps nothing.
 */

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** Not `PORT`, for the reason `apps/test-start` gives: one environment configures several processes. */
  DEMO_BANK_PORT: z.coerce.number().int().min(1).max(65_535).default(3203),
  DEMO_BANK_BIND_HOST: z.string().min(1).default("0.0.0.0"),
  PLATFORM_API_BASE_URL: z.string().url(),
  HOSTED_VERIFIER_SECRET: z.string().min(32),
  /** The presentation policy for each choice: `por=<id>,poa=<id>,poe=<id>`. */
  DEMO_BANK_POLICIES: z
    .string()
    .min(1)
    .transform((v) =>
      Object.fromEntries(
        v
          .split(",")
          .map((p) => p.trim().split("="))
          .filter(
            (p): p is [string, string] => p.length === 2 && Boolean(p[0]) && Boolean(p[1]),
          ),
      ),
    ),
});

type Config = Readonly<z.infer<typeof schema>>;

const CHOICES: readonly CredentialChoice[] = [
  {
    key: "por",
    name: "Poder de representación",
    description: "Para administradores y cargos inscritos que representan a la empresa.",
  },
  {
    key: "poa",
    name: "Poder notarial",
    description: "Para apoderados con un poder otorgado ante notario.",
  },
  {
    key: "poe",
    name: "Autorización de empleado",
    description: "Para empleados autorizados a operar en nombre de la empresa.",
  },
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IN_PROGRESS = new Set([
  "CREATED",
  "REQUEST_READY",
  "AWAITING_WALLET",
  "PRESENTATION_RECEIVED",
  "VERIFYING",
]);

/** An outcome in words a customer can act on. Codes only; never a certificate or a claim value. */
const FAILURES: Readonly<Record<string, readonly [string, string]>> = {
  REJECTED: [
    "Credencial no válida",
    "La credencial presentada no ha superado la verificación: su firma, su vigencia o su estado no son válidos.",
  ],
  POLICY_NOT_SATISFIED: [
    "Credencial insuficiente",
    "La credencial es válida, pero no contiene lo necesario para autorizar esta operación.",
  ],
  TRUST_ERROR: [
    "Emisor no reconocido",
    "No se ha podido confirmar que la credencial la emitió una entidad de confianza.",
  ],
  PROTOCOL_ERROR: [
    "Error de comunicación con la cartera",
    "La cartera y el banco no han completado el intercambio. Vuelva a intentarlo.",
  ],
  DECLINED_BY_USER: ["Presentación cancelada", "Ha cancelado la presentación en su cartera."],
  EXPIRED: [
    "Tiempo agotado",
    "La solicitud ha caducado antes de recibir la credencial. Vuelva a intentarlo.",
  ],
  CANCELLED: ["Solicitud cancelada", "La solicitud se ha cancelado."],
};

const secureHeaders = (response: Response): void => {
  response.setHeader(
    "content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  response.setHeader("cache-control", "no-store");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
};

const platform = async (
  config: Config,
  method: "GET" | "POST",
  path: string,
): Promise<{ status: number; json: Record<string, unknown> }> => {
  const response = await fetch(new URL(path, config.PLATFORM_API_BASE_URL), {
    method,
    headers: { "x-edtp-verifier-secret": config.HOSTED_VERIFIER_SECRET },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
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
  const choices = CHOICES.filter((c) => config.DEMO_BANK_POLICIES[c.key]);
  const choiceForPolicy = (policyId: string) =>
    choices.find((c) => config.DEMO_BANK_POLICIES[c.key] === policyId);

  const app = express();
  app.disable("x-powered-by");
  app.use(express.urlencoded({ extended: false, limit: "4kb" }));

  const unavailable = (response: Response): void => {
    response
      .status(503)
      .send(renderFailure("Servicio no disponible", "Inténtelo de nuevo en unos minutos."));
  };

  app.get("/", (_request, response) => {
    secureHeaders(response);
    response.send(renderHome(choices));
  });

  app.post("/verificar", async (request, response) => {
    secureHeaders(response);
    const key = typeof request.body?.tipo === "string" ? request.body.tipo : "";
    const choice = choices.find((c) => c.key === key);
    const policyId = choice ? config.DEMO_BANK_POLICIES[choice.key] : undefined;
    if (!choice || !policyId) {
      response.status(400).send(renderFailure("Solicitud no válida", "Elija una credencial."));
      return;
    }
    const started = await platform(
      config,
      "POST",
      `/v1/hosted-verifications/${encodeURIComponent(policyId)}`,
    ).catch(() => undefined);
    const walletUri = started?.json["walletUri"];
    if (started?.status !== 201 || typeof walletUri !== "string") return unavailable(response);
    response.send(renderOpenWallet(walletUri, choice.name));
  });

  // Where the wallet's return lands, via the platform's return route.
  app.get("/resultado", async (request, response) => {
    secureHeaders(response);
    const policyId = typeof request.query["policy"] === "string" ? request.query["policy"] : "";
    const presentationId =
      typeof request.query["presentation"] === "string" ? request.query["presentation"] : "";
    const choice = choiceForPolicy(policyId);
    if (!choice || !UUID.test(presentationId)) {
      response
        .status(400)
        .send(
          renderFailure("Solicitud no válida", "Vuelva a empezar desde la página del banco."),
        );
      return;
    }
    const outcome = await platform(
      config,
      "GET",
      `/v1/hosted-verifications/${encodeURIComponent(policyId)}/${encodeURIComponent(presentationId)}`,
    ).catch(() => undefined);
    if (!outcome || outcome.status !== 200) return unavailable(response);
    const status = String(outcome.json["status"] ?? "");
    if (IN_PROGRESS.has(status)) {
      response.send(renderWaiting());
      return;
    }
    if (status === "VERIFIED") {
      response.send(
        renderSuccess(choice.name, (outcome.json["claims"] as Record<string, unknown>) ?? {}),
      );
      return;
    }
    const [title, body] = FAILURES[status] ?? [
      "No se ha podido verificar",
      "La verificación no ha terminado correctamente. Vuelva a intentarlo.",
    ];
    response.status(422).send(renderFailure(title, body));
  });

  app.use((_request, response) => {
    secureHeaders(response);
    response.status(404).send(renderFailure("No encontrado", "Esta página no existe."));
  });

  app.listen(config.DEMO_BANK_PORT, config.DEMO_BANK_BIND_HOST, () => {
    process.stdout.write(
      `${JSON.stringify({ level: "info", service: "demo-bank", message: "listening", port: config.DEMO_BANK_PORT })}\n`,
    );
  });
};

main();
