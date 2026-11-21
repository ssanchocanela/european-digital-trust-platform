import { readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { z } from "zod";
import type { Dictionary } from "./i18n.js";

/**
 * A client's look for the demonstration, read at start from a directory on the host — never from
 * the repository. Banco Horizonte is the default and the only brand the code names.
 *
 * A branded instance is a demonstration **prepared for** a client, shown with the client's written
 * permission, and only behind Cloudflare Access (`docs/demo-onboarding-retail-style.md`). It is still
 * not the client's service: its band says so on every page, and a brand whose band and legal line do
 * not say it is a demonstration is refused at start. What the wallet shows at consent does not change
 * — that is the registered Relying Party, Banco Horizonte — and the band says that too.
 *
 *   <dir>/brand.json   { "name", "band", "legal", "shapeA", "shapeB", "logo" }
 *   <dir>/<logo>       an SVG or PNG, at most 512 KiB
 */

const MAX_LOGO_BYTES = 512 * 1024;
const COLOUR = /^#[0-9a-fA-F]{6}$/;
const DEMO = /demostraci[oó]n/i;

const brandSchema = z
  .object({
    name: z.string().min(2).max(40),
    band: z.string().min(20).max(300).regex(DEMO, "the band must say it is a demonstration"),
    legal: z
      .string()
      .min(20)
      .max(400)
      .regex(DEMO, "the legal line must say it is a demonstration"),
    shapeA: z.string().regex(COLOUR),
    shapeB: z.string().regex(COLOUR),
    logo: z.string().regex(/^[\w.-]+\.(svg|png)$/i),
  })
  .strict();

export interface Brand {
  readonly name: string;
  readonly band: string;
  readonly legal: string;
  readonly shapeA: string;
  readonly shapeB: string;
  readonly logo: { readonly bytes: Buffer; readonly type: string; readonly ext: string };
}

/** Reads and checks a brand directory. Throws, naming the problem, rather than start half-branded. */
export const loadBrand = (dir: string): Brand => {
  const parsed = brandSchema.safeParse(
    JSON.parse(readFileSync(join(dir, "brand.json"), "utf8")),
  );
  if (!parsed.success) {
    throw new Error(
      `brand.json: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  const b = parsed.data;
  const file = join(dir, b.logo);
  if (statSync(file).size > MAX_LOGO_BYTES) throw new Error(`${b.logo}: larger than 512 KiB`);
  const ext = extname(b.logo).slice(1).toLowerCase();
  return {
    name: b.name,
    band: b.band,
    legal: b.legal,
    shapeA: b.shapeA,
    shapeB: b.shapeB,
    logo: {
      bytes: readFileSync(file),
      type: ext === "svg" ? "image/svg+xml" : "image/png",
      ext,
    },
  };
};

/** Every text in the brand's name: Banco Horizonte's band and legal line replaced by the brand's own. */
export const brandDictionary = (t: Dictionary, brand: Brand | undefined): Dictionary => {
  if (!brand) return t;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(t)) {
    out[key] = value.replace(/Banco Horizonte/g, brand.name).replace(/Horizonte/g, brand.name);
  }
  out["band"] = brand.band;
  out["footerLegal"] = brand.legal;
  return out as Dictionary;
};

/** The brand's two colours, as a stylesheet of its own: the page allows no inline style. */
export const brandCss = (brand: Brand | undefined): string =>
  brand ? `:root { --shape-a:${brand.shapeA}; --shape-b:${brand.shapeB}; }\n` : "";
