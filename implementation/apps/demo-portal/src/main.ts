import express, { type Request, type Response } from "express";
import QRCode from "qrcode";
import { z } from "zod";
import {
  type DemoCard,
  type Health,
  renderForbidden,
  renderHome,
  renderOperator,
} from "./page.js";

/**
 * The demonstration portal (ADR 0010, `docs/demo-hosting-proposal.md` §3), at `demo.murcata.es`.
 *
 * Public: one card per demonstration, each with its steps, a live status dot, and — for those that start
 * on a web page — an "open on this phone" button and a QR carrying that page's address.
 *
 * `/operador`: the operator view. Cloudflare Access protects that path at the edge; this process also
 * refuses it unless the request carries the identity header Access injects. Requests only reach this
 * process through the VM's own tunnel, so a request cannot reach it without passing Access first.
 *
 * It holds **no secret** and calls nothing of the platform's that needs one: the status dots read
 * health routes on the internal network, and the issuer's public metadata through the gateway — what
 * any wallet reads — which also tells the operator view which branding profile is on.
 */

const url = z.string().url();
const schema = z.object({
  DEMO_PORTAL_PORT: z.coerce.number().int().min(1).max(65_535).default(3204),
  DEMO_PORTAL_BIND_HOST: z.string().min(1).default("0.0.0.0"),
  // Public addresses shown to visitors.
  PORTAL_BANK_URL: url.default("https://edtp-banco.murcata.es/"),
  PORTAL_SHOP_URL: url.default("https://edtp-banco.murcata.es/edad"),
  PORTAL_CLIENT_FORM_URL: url.default("https://edtp-cliente.murcata.es/"),
  // Internal addresses the status dots probe. Any answer below 500 counts as up.
  CHECK_PLATFORM_URL: url.default("http://platform-api:3100/health"),
  CHECK_FORM_URL: url.default("http://pid-form:3202/"),
  CHECK_BANK_URL: url.default("http://demo-bank:3203/"),
  /**
   * The PID issuer's public metadata, read through the filtering gateway exactly as a wallet reads it.
   * It is both the issuer's status dot and how the operator view tells which branding profile is on.
   */
  CHECK_ISSUER_METADATA_URL: url.default(
    "http://gateway:3010/.well-known/openid-credential-issuer/issuers/pid-1",
  ),
});
type Config = Readonly<z.infer<typeof schema>>;

/** The name the PID issuer has under the generic profile (`infra/demo-vm/profiles/generic.env`). */
const GENERIC_PID_ISSUER = "PID Demo Issuer";

const secureHeaders = (response: Response): void => {
  response.setHeader(
    "content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  );
  response.setHeader("cache-control", "no-store");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
};

const probe = async (target: string): Promise<Health> => {
  try {
    const r = await fetch(target, { signal: AbortSignal.timeout(3_000), redirect: "manual" });
    return r.status < 500 ? "up" : "down";
  } catch {
    return "down";
  }
};

/** Health, cached briefly so a busy page does not multiply probes. */
const healthCache = new Map<string, { at: number; value: Health }>();
const health = async (target: string): Promise<Health> => {
  const hit = healthCache.get(target);
  if (hit && Date.now() - hit.at < 30_000) return hit.value;
  const value = await probe(target);
  healthCache.set(target, { at: Date.now(), value });
  return value;
};
const all = (...hs: Health[]): Health => (hs.every((h) => h === "up") ? "up" : "down");

const qr = (text: string): Promise<string> =>
  QRCode.toString(text, { type: "svg", margin: 1, errorCorrectionLevel: "M" });

const cards = async (config: Config): Promise<DemoCard[]> => {
  const [platform, engine, form, bank] = await Promise.all([
    health(config.CHECK_PLATFORM_URL),
    health(config.CHECK_ISSUER_METADATA_URL),
    health(config.CHECK_FORM_URL),
    health(config.CHECK_BANK_URL),
  ]);
  const [bankQr, shopQr] = await Promise.all([
    qr(config.PORTAL_BANK_URL),
    qr(config.PORTAL_SHOP_URL),
  ]);
  return [
    {
      key: "pid",
      title: "Obtener un PID de prueba",
      summary:
        "Un PID sintético, con el modelo de datos del PID Rulebook, emitido a su cartera.",
      steps: [
        "Abra la cartera EDTP y vaya a Documentos → Añadir documento → Desde lista.",
        "Elija «PID (demo)» y rellene el formulario con datos ficticios.",
        "Confirme: la cartera recoge el PID.",
      ],
      health: all(platform, engine, form),
    },
    {
      key: "representacion",
      title: "Obtener una credencial de representante",
      summary:
        "Poder de representación, poder notarial o autorización de empleado, con su identidad tomada del PID.",
      steps: [
        "En la cartera, Añadir documento → Desde lista → «Registro Demo».",
        "Elija la credencial e identifíquese presentando su PID.",
        "Revise los datos y solicítela.",
      ],
      health: all(platform, engine, form),
    },
    {
      key: "banco",
      title: "Banco Demo: operar en nombre de una empresa",
      summary:
        "Un banco ficticio pide una credencial de representante para autorizar una transferencia.",
      steps: [
        "Abra la página del banco en el móvil que tiene la cartera.",
        "Elija la credencial y preséntela desde la cartera.",
        "Vuelva al banco: operación autorizada. Puede repetirlo con la misma credencial.",
      ],
      url: config.PORTAL_BANK_URL,
      qrSvg: bankQr,
      health: all(platform, engine, bank),
    },
    {
      key: "edad",
      title: "Tienda Demo: comprobar la mayoría de edad",
      summary: "La tienda recibe solo «mayor de 18», nunca la fecha de nacimiento del PID.",
      steps: [
        "Abra la página de la tienda en el móvil que tiene la cartera.",
        "Comparta la fecha de nacimiento desde su PID.",
        "La tienda solo ve el resultado: mayor de edad, sí o no.",
      ],
      url: config.PORTAL_SHOP_URL,
      qrSvg: shopQr,
      health: all(platform, engine, bank),
    },
  ];
};

/** The PID issuer's current display name: tells the operator which branding profile is on. */
const currentProfile = async (config: Config): Promise<{ name: string; client: boolean }> => {
  try {
    const r = await fetch(config.CHECK_ISSUER_METADATA_URL, {
      signal: AbortSignal.timeout(3_000),
    });
    const d = (await r.json()) as { display?: { name?: string }[] };
    const name = d.display?.[0]?.name ?? "desconocido";
    return name === GENERIC_PID_ISSUER
      ? { name: "genérico", client: false }
      : { name: `cliente (${name})`, client: true };
  } catch {
    return { name: "desconocido (el emisor no responde)", client: false };
  }
};

/** The identity Cloudflare Access injects once a visitor has logged in. */
const accessIdentity = (request: Request): string | undefined => {
  const email = request.header("cf-access-authenticated-user-email");
  return email?.includes("@") ? email : undefined;
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
  const app = express();
  app.disable("x-powered-by");

  app.get("/", async (_request, response) => {
    secureHeaders(response);
    response.send(renderHome(await cards(config)));
  });

  app.get("/operador", async (request, response) => {
    secureHeaders(response);
    const who = accessIdentity(request);
    if (!who) {
      response.status(403).send(renderForbidden());
      return;
    }
    const profile = await currentProfile(config);
    response.send(
      renderOperator({
        who,
        profile: profile.name,
        clientProfileOn: profile.client,
        links: [
          { label: "Banco Demo", url: config.PORTAL_BANK_URL },
          { label: "Tienda Demo (edad)", url: config.PORTAL_SHOP_URL },
          {
            label: "Formulario con marca de cliente (protegido)",
            url: config.PORTAL_CLIENT_FORM_URL,
          },
        ],
      }),
    );
  });

  app.use((_request, response) => {
    secureHeaders(response);
    response.status(404).send(renderForbidden().replace("Acceso restringido", "No encontrado"));
  });

  app.listen(config.DEMO_PORTAL_PORT, config.DEMO_PORTAL_BIND_HOST, () => {
    process.stdout.write(
      `${JSON.stringify({ level: "info", service: "demo-portal", message: "listening", port: config.DEMO_PORTAL_PORT })}\n`,
    );
  });
};

main();
