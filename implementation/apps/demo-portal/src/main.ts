import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import express, { type Request, type Response } from "express";
import QRCode from "qrcode";
import { z } from "zod";
import { ageVerificationCards } from "./age-verification.js";
import {
  type ChecksStatus,
  type DemoCard,
  type Health,
  type ProfileState,
  renderForbidden,
  renderHome,
  renderOperator,
} from "./page.js";
import { decideProfileRequest } from "./profile-request.js";
import { readTrustList } from "./trust-lists.js";

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
  PORTAL_FIBRE_URL: url.default("https://edtp-banco.murcata.es/fibra"),
  PORTAL_CLIENT_FORM_URL: url.default("https://edtp-cliente.murcata.es/"),
  // The age verification demos (ADR 0011). Off until they are deployed, so the portal never shows two
  // cards that cannot work.
  PORTAL_SHOW_AV_DEMOS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Banco Horizonte, the bank onboarding demonstration (ADR 0012). Off until it is deployed.
  PORTAL_SHOW_ONBOARDING: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // The income certificate Banco Horizonte's loan asks for. Off until its issuer is set up.
  PORTAL_SHOW_INCOME: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  PORTAL_ONBOARDING_URL: url.default("https://edtp-horizonte.murcata.es/"),
  CHECK_ONBOARDING_URL: url.default("http://demo-onboarding:3205/"),
  PORTAL_LUMEN_URL: url.default("https://av-lumen.murcata.es/"),
  PORTAL_PLAZA_URL: url.default("https://av-plaza.murcata.es/"),
  // Another compose project, so probed through its public name: that is also what a visitor reaches.
  CHECK_LUMEN_URL: url.default("https://av-lumen.murcata.es/healthz"),
  CHECK_PLAZA_URL: url.default("https://av-plaza.murcata.es/healthz"),
  /** The scheduled negative checks' last result, mounted read-only on the VM. */
  PORTAL_STATUS_FILE: z.string().min(1).optional(),
  /**
   * The directory shared with the host for branding-profile requests (ADR 0010 §2). The portal only
   * writes `request.json` there; a systemd path unit on the VM applies it. Unset: no button.
   */
  PORTAL_PROFILE_DIR: z.string().min(1).optional(),
  /**
   * A directory of trust lists to publish at `/lote/<name>.jwt`, mounted read-only on the VM
   * (`trust-lists.ts`). Unset: the path does not exist.
   */
  PORTAL_LOTE_DIR: z.string().min(1).optional(),
  PORTAL_PROFILES: z
    .string()
    .default("generic,fnmt-corpme,gobcan")
    .transform((v) =>
      v
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean),
    ),
  /** This portal's own origin, which a profile request must come from. */
  PORTAL_ORIGIN: url.default("https://demo.murcata.es"),
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
  /**
   * The Large Family Title issuer's public metadata. A client profile may brand only this issuer
   * (`gobcan`), so the PID issuer's name alone cannot tell the operator which profile is on.
   */
  CHECK_FAMILY_METADATA_URL: url.default(
    "http://gateway:3010/.well-known/openid-credential-issuer/issuers/fam-1",
  ),
});
type Config = Readonly<z.infer<typeof schema>>;

/** The name the PID issuer has under the generic profile (`infra/demo-vm/profiles/generic.env`). */
const GENERIC_PID_ISSUER = "PID Demo Issuer";
const GENERIC_FAMILY_ISSUER = "Comunidad Autónoma Demo";

const secureHeaders = (response: Response): void => {
  response.setHeader(
    "content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
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
  const [bankQr, shopQr, fibreQr] = await Promise.all([
    qr(config.PORTAL_BANK_URL),
    qr(config.PORTAL_SHOP_URL),
    qr(config.PORTAL_FIBRE_URL),
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
    {
      key: "familia",
      title: "Obtener un Título de Familia Numerosa",
      summary:
        "Expedido por una comunidad autónoma ficticia, con su identidad tomada del PID y los datos de la familia ficticios.",
      steps: [
        "En la cartera, Añadir documento → Desde lista → «Comunidad Autónoma Demo».",
        "Elija el Título de Familia Numerosa e identifíquese presentando su PID.",
        "Revise los datos y solicítelo.",
      ],
      health: all(platform, engine, form),
    },
    {
      key: "fibra",
      title: "Fibra Demo: descuento de familia numerosa",
      summary:
        "Una operadora ficticia aplica un 30 % de descuento. Recibe solo la categoría y la validez del título.",
      steps: [
        "Abra la página de la operadora en el móvil que tiene la cartera.",
        "Comparta la categoría y la validez de su Título de Familia Numerosa.",
        "Vuelva a la operadora: descuento aplicado. Ni su nombre ni su fecha de nacimiento.",
      ],
      url: config.PORTAL_FIBRE_URL,
      qrSvg: fibreQr,
      health: all(platform, engine, bank),
    },
    ...(config.PORTAL_SHOW_ONBOARDING
      ? [
          {
            key: "horizonte",
            title: "Banco Horizonte: hacerse cliente con el PID",
            summary:
              "Un banco ficticio abre una cuenta con los datos del PID, y lo compara con el alta de hoy, simulada.",
            steps: [
              "Abra la página en un ordenador y elija «Onboarding con EUDI Wallet».",
              "Escanee el código con la cartera y comparta los datos de su PID.",
              "El formulario se rellena solo. La firma final es simulada.",
            ],
            url: config.PORTAL_ONBOARDING_URL,
            qrSvg: await qr(config.PORTAL_ONBOARDING_URL),
            health: all(platform, engine, await health(config.CHECK_ONBOARDING_URL)),
          },
          ...(config.PORTAL_SHOW_INCOME
            ? [
                {
                  key: "ingresos",
                  title: "Obtener un certificado de ingresos",
                  summary:
                    "Expedido por una gestora de nóminas ficticia, con su identidad tomada del PID. El empleador y el salario son ficticios. Banco Horizonte lo pide para el préstamo.",
                  steps: [
                    "En la cartera, Añadir documento → Desde lista → «Nóminas Demo».",
                    "Elija el certificado de ingresos e identifíquese presentando su PID.",
                    "Revise los datos y solicítelo.",
                  ],
                  health: all(platform, engine, form),
                },
              ]
            : []),
        ]
      : []),
    ...(config.PORTAL_SHOW_AV_DEMOS ? await avCards(config) : []),
  ];
};

const avCards = async (config: Config): Promise<DemoCard[]> => {
  const [lumenHealth, plazaHealth, lumenQr, plazaQr] = await Promise.all([
    health(config.CHECK_LUMEN_URL),
    health(config.CHECK_PLAZA_URL),
    qr(config.PORTAL_LUMEN_URL),
    qr(config.PORTAL_PLAZA_URL),
  ]);
  return ageVerificationCards(
    { url: config.PORTAL_LUMEN_URL, qrSvg: lumenQr, health: lumenHealth },
    { url: config.PORTAL_PLAZA_URL, qrSvg: plazaQr, health: plazaHealth },
  );
};

/** An issuer's current display name, from its public metadata. */
const issuerName = async (url: string): Promise<string | undefined> => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    const d = (await r.json()) as { display?: { name?: string }[] };
    return d.display?.[0]?.name;
  } catch {
    return undefined;
  }
};

/**
 * Which branding profile is on, told by the issuers' display names: a client profile renames the PID
 * issuer (`fnmt-corpme`) or the Large Family Title's (`gobcan`). Generic only when both carry their
 * generic names.
 */
const currentProfile = async (config: Config): Promise<{ name: string; client: boolean }> => {
  const [pid, family] = await Promise.all([
    issuerName(config.CHECK_ISSUER_METADATA_URL),
    issuerName(config.CHECK_FAMILY_METADATA_URL),
  ]);
  if (pid === undefined) return { name: "desconocido (el emisor no responde)", client: false };
  if (pid !== GENERIC_PID_ISSUER) return { name: `cliente (${pid})`, client: true };
  if (family !== undefined && family !== GENERIC_FAMILY_ISSUER)
    return { name: `cliente (${family})`, client: true };
  return { name: "genérico", client: false };
};

const lastChecks = async (config: Config): Promise<ChecksStatus | undefined> => {
  if (!config.PORTAL_STATUS_FILE) return undefined;
  try {
    const d = JSON.parse(await readFile(config.PORTAL_STATUS_FILE, "utf8")) as ChecksStatus;
    return typeof d.at === "string" && typeof d.result === "string" ? d : undefined;
  } catch {
    return undefined;
  }
};

const readJson = async <T>(path: string): Promise<T | undefined> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
};

const profileState = async (
  config: Config,
  notice?: ProfileState["notice"],
): Promise<ProfileState | undefined> => {
  if (!config.PORTAL_PROFILE_DIR) return undefined;
  const pending = await readJson<ProfileState["pending"]>(
    join(config.PORTAL_PROFILE_DIR, "request.json"),
  );
  const last = await readJson<ProfileState["last"]>(
    join(config.PORTAL_PROFILE_DIR, "last.json"),
  );
  return {
    profiles: config.PORTAL_PROFILES,
    ...(pending ? { pending } : {}),
    ...(last ? { last } : {}),
    ...(notice ? { notice } : {}),
  };
};

/**
 * Whether a form submission comes from this portal's own page: the browser's fetch metadata says
 * same-origin, or the Origin header is this portal. Stops another site from submitting it in the
 * operator's name.
 */
const sameOrigin = (request: Request, origin: string): boolean => {
  const site = request.header("sec-fetch-site");
  if (site) return site === "same-origin";
  return request.header("origin") === origin;
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

  const operatorPage = async (
    request: Request,
    response: Response,
    notice?: ProfileState["notice"],
  ): Promise<void> => {
    const who = accessIdentity(request);
    if (!who) {
      response.status(403).send(renderForbidden());
      return;
    }
    const [profile, checks, state] = await Promise.all([
      currentProfile(config),
      lastChecks(config),
      profileState(config, notice),
    ]);
    response.send(
      renderOperator({
        who,
        ...(checks ? { checks } : {}),
        ...(state ? { profileState: state } : {}),
        profile: profile.name,
        clientProfileOn: profile.client,
        links: [
          { label: "Banco Demo", url: config.PORTAL_BANK_URL },
          { label: "Tienda Demo (edad)", url: config.PORTAL_SHOP_URL },
          ...(config.PORTAL_SHOW_AV_DEMOS
            ? [
                { label: "Lumen (verificación de edad)", url: config.PORTAL_LUMEN_URL },
                { label: "Plaza (verificación de edad)", url: config.PORTAL_PLAZA_URL },
              ]
            : []),
          {
            label: "Formulario con marca de cliente (protegido)",
            url: config.PORTAL_CLIENT_FORM_URL,
          },
        ],
      }),
    );
  };

  // Trust lists, as files an operator placed in the directory. Public, like any trust list.
  app.get("/lote/:name", async (request, response, next) => {
    const list = await readTrustList(config.PORTAL_LOTE_DIR, request.params.name);
    if (list === undefined) return next();
    response.setHeader("x-content-type-options", "nosniff");
    // Revalidated on every fetch: a replaced list must not be outlived by a cached copy.
    response.setHeader("cache-control", "no-cache");
    // The media type the reference environment serves its lists with.
    response.type("application/octet-stream").send(list);
  });

  app.get("/operador", async (request, response) => {
    secureHeaders(response);
    await operatorPage(request, response);
  });

  // A branding-profile request. It is written to the shared directory and applied on the host.
  app.post(
    "/operador",
    express.urlencoded({ extended: false, limit: "1kb" }),
    async (request, response) => {
      secureHeaders(response);
      const dir = config.PORTAL_PROFILE_DIR;
      if (!dir) {
        response.status(404).send(renderForbidden());
        return;
      }
      const decision = decideProfileRequest({
        profile: request.body?.perfil,
        permission: request.body?.permiso,
        who: accessIdentity(request),
        allowed: config.PORTAL_PROFILES,
        sameOrigin: sameOrigin(request, config.PORTAL_ORIGIN),
        now: new Date(),
      });
      if (!decision.ok) {
        response.status(accessIdentity(request) ? 422 : 403);
        await operatorPage(request, response, { ok: false, text: decision.reason });
        return;
      }
      // Written then renamed, so the host never reads a half-written file.
      const tmp = join(dir, `.request-${Date.now()}.json`);
      await writeFile(tmp, `${JSON.stringify(decision.request)}\n`, { mode: 0o644 });
      await rename(tmp, join(dir, "request.json"));
      await operatorPage(request, response, {
        ok: true,
        text: `Solicitud registrada: ${decision.request.profile}. Se aplicará en menos de un minuto.`,
      });
    },
  );

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
