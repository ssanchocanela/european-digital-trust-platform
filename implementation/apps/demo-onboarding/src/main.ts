import { createHash } from "node:crypto";
import { clientKey, RateLimiter } from "@edtp/shared";
import express, { type Request, type Response } from "express";
import qrcode from "qrcode-generator";
import { z } from "zod";
import { CaseBook } from "./backoffice.js";
import { type Brand, brandCss, brandDictionary, loadBrand } from "./brand.js";
import {
  FIELDS,
  INCOME_REQUESTED_CLAIMS,
  LOGIN_REQUESTED_CLAIMS,
  loginDocument,
  REQUESTED_CLAIMS,
  toIncomeData,
  toOnboardingData,
} from "./claims.js";
import { CLIENT_JS } from "./client.js";
import { CustomerBook } from "./customers.js";
import { dictionary } from "./i18n.js";
import {
  APP_CSS,
  CONTENT_SECURITY_POLICY,
  renderBackoffice,
  renderPlain,
  renderShell,
} from "./page.js";
import { CrossDevicePolls } from "./polls.js";
import { RECORDED_CLAIMS, RECORDED_INCOME_CLAIMS, RECORDED_STATUSES } from "./recorded.js";

/**
 * Banco Horizonte — the bank onboarding demonstration.
 *
 * A fictitious bank's "open an account" page, shown three ways: the onboarding of today, simulated;
 * the same onboarding with a PID presented from a wallet, real; and the two side by side. The
 * simulated one calls nothing. The real one asks the platform's hosted verifier for a presentation
 * under one policy, shows the wallet the way in, and fills the form from the verified result.
 *
 * ## What it can do, which is little
 *
 * - One secret: the hosted-verifier secret, accepted by the platform only for the policies
 *   configured for it. No tenant key, no database, no session, no cookie.
 * - It never chooses where the wallet returns: the platform sets that from its own configuration.
 * - It may ask for a cross-device (`QR`) presentation, because the platform's configuration opens
 *   this policy to it (ADR 0012). The ADR 0009 mitigations apply there, and this page adds its part
 *   of one: the outcome of a `QR` presentation is given only to the browser that asked for it.
 * - It shows the verified claims to the person who presented them. It keeps nothing — unless the
 *   back office is switched on (`ONBOARDING_BACKOFFICE=on`), when it holds the last few
 *   applications in memory for half an hour and shows them at `/backoffice`, a page it serves only
 *   to a visitor Cloudflare Access has identified (`backoffice.ts`).
 *
 * Without a policy it still runs: the simulation, and a recording in place of the wallet, announced
 * on every screen for as long as it plays.
 *
 * ## The login
 *
 * A customer who opened an account here signs in by presenting their PID under a second policy,
 * which asks for the personal administrative number only. The process recognises it by an HMAC it
 * keeps from the account opening, and greets the given name it kept then (`customers.ts`). That is
 * the one other thing this process holds, in memory, whatever the back office's setting.
 */

const schema = z.object({
  /** Per-client limits per minute (ADR 0010 §3); `0` disables. POSTs are what create platform work. */
  ONBOARDING_RATE_POST_PER_MIN: z.coerce.number().int().min(0).default(10),
  ONBOARDING_RATE_GET_PER_MIN: z.coerce.number().int().min(0).default(240),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  ONBOARDING_PORT: z.coerce.number().int().min(1).max(65_535).default(3205),
  ONBOARDING_BIND_HOST: z.string().min(1).default("0.0.0.0"),
  PLATFORM_API_BASE_URL: z.string().url(),
  HOSTED_VERIFIER_SECRET: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().min(32).optional(),
  ),
  /** The presentation policy `scripts/register-bank-onboarding.mjs` prints. Unset: recording only. */
  ONBOARDING_POLICY: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().uuid().optional(),
  ),
  /**
   * The loan's second presentation: the income certificate's policy, from
   * `register-large-family.mjs presentation` with the income definition. Unset: the loan decides on
   * an income the person types, and says so.
   */
  ONBOARDING_INCOME_POLICY: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().uuid().optional(),
  ),
  /**
   * The back office, and with it the only state this process keeps. Off by default, and to be
   * switched on **only after** Cloudflare Access has been seen protecting `/backoffice` on the
   * public hostname: the page trusts the identity header Access injects, which means something only
   * when no request can reach this process without passing Access.
   */
  ONBOARDING_BACKOFFICE: z.enum(["on", "off"]).default("off"),
  /** The login's policy: `register-bank-onboarding.mjs policy … --login`. Unset: no wallet login. */
  ONBOARDING_LOGIN_POLICY: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().uuid().optional(),
  ),
  /**
   * A client's look (`brand.ts`), from a directory on the host. Unset: Banco Horizonte. Only for an
   * instance that Cloudflare Access protects whole, shown with the client's written permission.
   */
  ONBOARDING_BRAND_DIR: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().min(1).optional(),
  ),
});

type Config = Readonly<z.infer<typeof schema>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The identity Cloudflare Access injects once a visitor has logged in. */
const accessIdentity = (request: Request): string | undefined => {
  const email = request.header("cf-access-authenticated-user-email");
  return email && /^[^\s@]{1,64}@[^\s@]{1,255}$/.test(email) ? email : undefined;
};

/** How the page says an application ended. Bounded: it is shown to the back office as declared. */
const declaredSchema = z
  .object({
    product: z.enum(["cuenta", "prestamo"]),
    signed: z.boolean(),
    amount: z.number().int().min(0).max(1_000_000).optional(),
    months: z.number().int().min(1).max(480).optional(),
    granted: z.number().int().min(0).max(1_000_000).optional(),
    monthlyPayment: z.number().min(0).max(1_000_000).optional(),
  })
  .strict();

const secureHeaders = (response: Response): void => {
  response.setHeader("content-security-policy", CONTENT_SECURITY_POLICY);
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
      "x-edtp-verifier-secret": config.HOSTED_VERIFIER_SECRET ?? "",
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

/** An SVG QR code. The data becomes geometry: nothing of the input reaches an attribute. */
const qrSvg = (value: string): string => {
  const qr = qrcode(0, "M");
  qr.addData(value);
  qr.make();
  return qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
};

/** The three things the page asks a wallet for: a PID to open an account, an income certificate, a PID to log in. */
type Kind = "pid" | "ingresos" | "acceso";
const CREDENTIALS = {
  pid: { vct: "urn:eudi:pid:1", requestedClaims: REQUESTED_CLAIMS },
  ingresos: { vct: "urn:edtp:income-certificate:1", requestedClaims: INCOME_REQUESTED_CLAIMS },
  acceso: { vct: "urn:eudi:pid:1", requestedClaims: LOGIN_REQUESTED_CLAIMS },
} as const;

/** What the technical panel shows of the request: its shape, never a secret and never content. */
const requestSummary = (
  kind: Kind,
  presentationId: string,
  interactionType: string,
  walletUri: string,
  expiresAt: unknown,
) => {
  let requestUri = "";
  try {
    const inner = new URL(walletUri).searchParams.get("request_uri");
    if (inner) {
      const u = new URL(inner);
      requestUri = `${u.origin}${u.pathname.replace(/[0-9a-f-]{20,}/gi, (s) => `${s.slice(0, 8)}…`)}`;
    }
  } catch {
    // A URI the page cannot parse is still one a wallet may open; the panel shows no request URI.
  }
  return {
    protocol: "OpenID4VP",
    presentationId: `${presentationId.slice(0, 8)}…`,
    interactionType,
    ...(requestUri ? { requestUri } : {}),
    credential: { format: "dc+sd-jwt", vct: CREDENTIALS[kind].vct },
    requestedClaims: CREDENTIALS[kind].requestedClaims,
    expiresAt,
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
  const policy = config.HOSTED_VERIFIER_SECRET ? config.ONBOARDING_POLICY : undefined;
  // The income step exists only on top of the identification: never one without the other.
  const incomePolicy = policy ? config.ONBOARDING_INCOME_POLICY : undefined;
  // The login recognises customers the account opening made: never one without the other.
  const loginPolicy = policy ? config.ONBOARDING_LOGIN_POLICY : undefined;
  const policyFor = (kind: Kind): string | undefined =>
    kind === "pid" ? policy : kind === "ingresos" ? incomePolicy : loginPolicy;
  const kindOf = (value: unknown): Kind =>
    value === "ingresos" ? "ingresos" : value === "acceso" ? "acceso" : "pid";
  const customers = new CustomerBook();
  const polls = new CrossDevicePolls();
  // Only with the back office on is anything a wallet presented kept past the request.
  const book = config.ONBOARDING_BACKOFFICE === "on" ? new CaseBook() : undefined;
  const today = () => new Date().toISOString().slice(0, 10);

  // Content-versioned, so a cache in front never serves yesterday's script with today's page.
  let brand: Brand | undefined;
  try {
    brand = config.ONBOARDING_BRAND_DIR ? loadBrand(config.ONBOARDING_BRAND_DIR) : undefined;
  } catch (error) {
    process.stderr.write(`Invalid brand: ${(error as Error).message}\n`);
    process.exit(1);
  }
  const BRAND_CSS = brandCss(brand);
  const brandName = brand?.name ?? "Banco Horizonte";
  const texts = (lang: string | undefined) => {
    const d = dictionary(lang);
    return { lang: d.lang, t: brandDictionary(d.t, brand) };
  };

  // Content-versioned, so a cache in front never serves yesterday's script with today's page.
  const version = createHash("sha256")
    .update(APP_CSS)
    .update(CLIENT_JS)
    .update(BRAND_CSS)
    .update(brand?.logo.bytes ?? "")
    .digest("hex")
    .slice(0, 12);
  const assets = `assets/${version}`;
  const brandUrls = (b: Brand) => ({
    name: b.name,
    logo: `${assets}/logo.${b.logo.ext}`,
    css: `${assets}/brand.css`,
  });

  const recorded = {
    statuses: RECORDED_STATUSES,
    fields: toOnboardingData(RECORDED_CLAIMS, today()).fields,
    request: requestSummary("pid", "00000000", "RECORDED", "", null),
    income: toIncomeData(RECORDED_INCOME_CLAIMS),
    incomeRequest: requestSummary("ingresos", "00000000", "RECORDED", "", null),
    loginRequest: requestSummary("acceso", "00000000", "RECORDED", "", null),
    customer: {
      givenName: String(RECORDED_CLAIMS["given_name"] ?? ""),
      iban: "ES00 0000 0000 0000 0000 0000",
    },
  };

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1kb" }));

  const postLimit = new RateLimiter({
    max: config.ONBOARDING_RATE_POST_PER_MIN,
    windowMs: 60_000,
  });
  const getLimit = new RateLimiter({
    max: config.ONBOARDING_RATE_GET_PER_MIN,
    windowMs: 60_000,
  });
  app.use((request, response, next) => {
    const limiter = request.method === "POST" ? postLimit : getLimit;
    const decision = limiter.take(clientKey(request.headers, request.socket.remoteAddress));
    if (decision.allowed) return next();
    secureHeaders(response);
    response.setHeader("retry-after", String(decision.retryAfterSeconds));
    response.status(429).json({ error: "rate_limited" });
  });

  const shell = (lang: unknown, resume?: string, resumeKind?: Kind): string => {
    const { lang: chosen, t } = texts(typeof lang === "string" ? lang : undefined);
    return renderShell({
      lang: chosen,
      t,
      assets,
      live: Boolean(policy),
      // With no policy at all the page plays its recording, income certificate included.
      income: Boolean(incomePolicy) || !policy,
      login: Boolean(loginPolicy) || !policy,
      ...(brand ? { brand: brandUrls(brand) } : {}),
      ...(resume ? { resume, resumeKind: resumeKind ?? "pid" } : {}),
      recorded,
    });
  };

  app.get("/", (request, response) => {
    secureHeaders(response);
    response.send(shell(request.query["lang"]));
  });

  // Where the wallet's same-device return lands, via the platform's return route.
  app.get("/resultado", (request, response) => {
    secureHeaders(response);
    const presentationId =
      typeof request.query["presentation"] === "string" ? request.query["presentation"] : "";
    const returned = request.query["policy"];
    const kind: Kind | undefined =
      policy && returned === policy
        ? "pid"
        : incomePolicy && returned === incomePolicy
          ? "ingresos"
          : loginPolicy && returned === loginPolicy
            ? "acceso"
            : undefined;
    if (!kind || !UUID.test(presentationId)) {
      response.redirect(303, "./");
      return;
    }
    response.send(shell(request.query["lang"], presentationId, kind));
  });

  app.get(`/${assets}/app.css`, (_request, response) => {
    response.setHeader("cache-control", "public, max-age=31536000, immutable");
    response.type("css").send(APP_CSS);
  });
  if (brand) {
    const logo = brand.logo;
    app.get(`/${assets}/brand.css`, (_request, response) => {
      response.setHeader("cache-control", "public, max-age=31536000, immutable");
      response.type("css").send(BRAND_CSS);
    });
    app.get(`/${assets}/logo.${logo.ext}`, (_request, response) => {
      response.setHeader("cache-control", "public, max-age=31536000, immutable");
      response.setHeader("x-content-type-options", "nosniff");
      // Opened on its own, an SVG is a document: it may draw, never run anything.
      response.setHeader(
        "content-security-policy",
        "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      );
      response.type(logo.type).send(logo.bytes);
    });
  }
  app.get(`/${assets}/app.js`, (_request, response) => {
    response.setHeader("cache-control", "public, max-age=31536000, immutable");
    response.type("js").send(CLIENT_JS);
  });

  app.post("/api/presentaciones", async (request, response) => {
    secureHeaders(response);
    const kind = kindOf(request.body?.tipo);
    const target = policyFor(kind);
    if (!target) {
      response.status(503).json({ error: "not_configured" });
      return;
    }
    const interactionType = request.body?.modo === "qr" ? "QR" : "SAME_DEVICE";
    const started = await platform(
      config,
      "POST",
      `/v1/hosted-verifications/${encodeURIComponent(target)}`,
      { interactionType },
    ).catch(() => undefined);
    const walletUri = started?.json["walletUri"];
    const id = started?.json["presentationId"];
    if (started?.status !== 201 || typeof walletUri !== "string" || typeof id !== "string") {
      response.status(503).json({ error: "unavailable" });
      return;
    }
    const expiresAt = started.json["expiresAt"];
    // For the back office: what this application is for, said now so that a case in progress can
    // be told from another, and which case a second document belongs to. Both are the page's word.
    if (kind === "pid") {
      const product = request.body?.producto === "prestamo" ? "prestamo" : "cuenta";
      book?.expect(id, product, product === "prestamo" && Boolean(incomePolicy));
    } else if (
      kind === "ingresos" &&
      typeof request.body?.pid === "string" &&
      UUID.test(request.body.pid)
    ) {
      book?.link(id, request.body.pid);
    }
    response.status(201).json({
      id,
      walletUri,
      expiresAt,
      request: requestSummary(kind, id, interactionType, walletUri, expiresAt),
      ...(interactionType === "QR"
        ? { qrSvg: qrSvg(walletUri), token: polls.remember(id) }
        : {}),
    });
  });

  app.get("/api/presentaciones/:id", async (request, response) => {
    secureHeaders(response);
    const id = request.params.id;
    const token = request.headers["x-onboarding-token"];
    const kind = kindOf(request.query["tipo"]);
    const target = policyFor(kind);
    if (
      !target ||
      !UUID.test(id) ||
      !polls.allows(id, typeof token === "string" ? token : undefined)
    ) {
      response.status(404).json({ error: "not_found" });
      return;
    }
    const outcome = await platform(
      config,
      "GET",
      `/v1/hosted-verifications/${encodeURIComponent(target)}/${encodeURIComponent(id)}`,
    ).catch(() => undefined);
    if (!outcome || outcome.status !== 200) {
      response.status(outcome?.status === 404 ? 404 : 503).json({ error: "unavailable" });
      return;
    }
    const status = String(outcome.json["status"] ?? "");
    if (status !== "VERIFIED") {
      response.json({ status });
      return;
    }
    // The verified claims, to the page the person is looking at. Only the form's fields: anything
    // else a result might carry stops here.
    const claims = (outcome.json["claims"] as Record<string, unknown>) ?? {};
    if (kind === "ingresos") {
      const income = toIncomeData(claims);
      if (income) book?.income(id, income);
      response.json(income ? { status, income } : { status: "POLICY_NOT_SATISFIED" });
      return;
    }
    if (kind === "acceso") {
      // The number is hashed, looked up and dropped here. Only what the bank kept goes back.
      const document = loginDocument(claims);
      const customer = document === undefined ? undefined : customers.find(document);
      response.json(
        document === undefined
          ? { status: "NO_DOCUMENT" }
          : customer
            ? { status, customer: { givenName: customer.givenName, iban: customer.iban } }
            : { status: "NOT_A_CUSTOMER" },
      );
      return;
    }
    const identity = toOnboardingData(claims, today());
    book?.identity(id, identity);
    // Held against this presentation until a contract is signed: then the person is a customer.
    const document = loginDocument(claims);
    const alreadyCustomer = document !== undefined && customers.isCustomer(document);
    if (document !== undefined && !alreadyCustomer) {
      const givenName = identity.fields.find((f) => f.path === "given_name")?.value ?? "";
      customers.expect(id, document, givenName);
    }
    response.json({ status, ...identity, alreadyCustomer });
  });

  // How an application ended, as the page worked it out. It lands on a case only a verified PID
  // presentation can have opened, and is shown to the back office as declared. A signed account
  // makes the person a customer, who can then log in with the wallet.
  app.post("/api/expedientes/:id", (request, response) => {
    secureHeaders(response);
    const declared = declaredSchema.safeParse(request.body);
    if (!UUID.test(request.params.id) || !declared.success) {
      response.status(404).json({ error: "not_found" });
      return;
    }
    const enrolled =
      declared.data.product === "cuenta" && declared.data.signed
        ? customers.enrol(request.params.id) !== undefined
        : false;
    const declaredToBook = book?.declare(request.params.id, declared.data) ?? false;
    response.status(enrolled || declaredToBook ? 204 : 404).end();
  });

  // The back office. Served only when it is switched on and only to a visitor Access has
  // identified; to anyone else this path does not exist.
  app.get("/backoffice", (request, response, next) => {
    const who = accessIdentity(request);
    if (!book || !who) return next();
    secureHeaders(response);
    const { t } = texts(undefined);
    response.send(
      renderBackoffice({
        t,
        assets,
        who,
        cases: book.list(),
        now: new Date(),
        ...(brand ? { brand: brandUrls(brand) } : {}),
      }),
    );
  });

  app.use((request, response) => {
    secureHeaders(response);
    const { t } = texts(undefined);
    if (request.path.startsWith("/api/")) {
      response.status(404).json({ error: "not_found" });
      return;
    }
    response
      .status(404)
      .send(renderPlain(t, "No encontrado", "Esta página no existe.", "/" + assets, brandName));
  });

  app.listen(config.ONBOARDING_PORT, config.ONBOARDING_BIND_HOST, () => {
    process.stdout.write(
      `${JSON.stringify({ level: "info", service: "demo-onboarding", message: "listening", port: config.ONBOARDING_PORT, live: Boolean(policy), login: Boolean(loginPolicy), brand: brand?.name ?? null, fields: FIELDS.length, backoffice: Boolean(book) })}\n`,
    );
  });
};

main();
