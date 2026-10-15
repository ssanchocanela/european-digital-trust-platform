#!/usr/bin/env node
/**
 * Draws the FNMT-RCM colour brand's wallet resources from the organisation's own colour logo.
 *
 *   npm install --no-save sharp && node tools/test-wallet/brands/fnmt-color/make-assets.mjs
 *
 * The output, `res/`, is committed, so a build needs neither this script nor `sharp`. Run it again
 * only when the source logo changes.
 *
 * The source is `source/logo_fnmt_30mm_color.png`, from the PNG pack FNMT-RCM publishes at
 * https://www.fnmt.es/prensa/identidad-corporativa (the "reproducción color" variant), unaltered. Its
 * white background is made transparent, keeping each pixel's own colour; nothing is redrawn or
 * recoloured, except that the dark theme gets a copy whose black lettering is white, so that it can
 * be read on a dark background. The blue stays the logo's blue.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "source", "logo_fnmt_30mm_color.png");
/** The emblem's box in the source: the first run of ink, measured, not guessed. */
const EMBLEM = { left: 0, top: 0, width: 323, height: 392 };

/**
 * White made transparent, keeping colour: each pixel's alpha is how far it is from white, and its
 * colour is what, composited over white at that alpha, gives back the original. With `lightInk`, a
 * pixel with no hue — the black lettering — is drawn white instead.
 */
const unwhite = async (input, lightInk = false) => {
  const { data, info } = await sharp(input).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(info.width * info.height * 4);
  for (let i = 0; i < info.width * info.height; i++) {
    const [r, g, b] = [data[i * 3], data[i * 3 + 1], data[i * 3 + 2]];
    const a = Math.max(255 - r, 255 - g, 255 - b);
    let rgb = a === 0 ? [0, 0, 0] : [r, g, b].map((c) => Math.round((255 * (c - (255 - a))) / a));
    if (lightInk && Math.max(...rgb) - Math.min(...rgb) < 40) rgb = [255, 255, 255];
    out.set([...rgb, a], i * 4);
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
};

const out = (...parts) => {
  const path = join(here, "res", ...parts);
  mkdirSync(dirname(path), { recursive: true });
  return path;
};
const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
const white = { r: 255, g: 255, b: 255, alpha: 1 };

/** `mark` scaled to fit `inner` pixels, centred on a `size` square of `background`. */
const centred = async (mark, size, inner, background) => {
  const scaled = await sharp(mark).resize(inner, inner, { fit: "inside" }).toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background } }).composite([
    { input: scaled, gravity: "centre" },
  ]);
};

const emblemSource = await sharp(source).extract(EMBLEM).toBuffer();
for (const [qualifier, lightInk] of [["", false], ["-night", true]]) {
  const logo = await unwhite(source, lightInk);
  const emblem = await unwhite(emblemSource, lightInk);
  // In-app: the splash mark (160 dp) and the header's logo (161 dp wide), at xxhdpi.
  await (await centred(emblem, 480, 400, transparent)).png().toFile(out(`drawable${qualifier}-xxhdpi`, "ic_logo_icon.png"));
  await sharp(logo).resize({ width: 483 }).png().toFile(out(`drawable${qualifier}-xxhdpi`, "ic_logo_icon_and_text.png"));
}

// The launcher icon: the blue emblem on white. The adaptive foreground keeps to the 66 dp safe zone.
const emblem = await unwhite(emblemSource);
for (const [density, scale] of [["mdpi", 1], ["hdpi", 1.5], ["xhdpi", 2], ["xxhdpi", 3], ["xxxhdpi", 4]]) {
  const foreground = Math.round(108 * scale);
  const legacy = Math.round(48 * scale);
  await (await centred(emblem, foreground, Math.round(54 * scale), transparent))
    .webp({ lossless: true })
    .toFile(out(`mipmap-${density}`, "ic_launcher_foreground.webp"));
  const square = await (await centred(emblem, legacy, Math.round(32 * scale), white)).png().toBuffer();
  await sharp(square).webp({ lossless: true }).toFile(out(`mipmap-${density}`, "ic_launcher.webp"));
  const circle = Buffer.from(
    `<svg width="${legacy}" height="${legacy}"><circle cx="${legacy / 2}" cy="${legacy / 2}" r="${legacy / 2}"/></svg>`,
  );
  await sharp(square)
    .composite([{ input: circle, blend: "dest-in" }])
    .webp({ lossless: true })
    .toFile(out(`mipmap-${density}`, "ic_launcher_round.webp"));
}
console.log("written", join(here, "res"));
