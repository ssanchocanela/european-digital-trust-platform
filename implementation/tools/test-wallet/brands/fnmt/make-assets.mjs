#!/usr/bin/env node
/**
 * Draws the FNMT-RCM brand's wallet resources from the organisation's own black-and-white logo.
 *
 *   npm install --no-save sharp && node tools/test-wallet/brands/fnmt/make-assets.mjs
 *
 * The output, `res/`, is committed, so a build needs neither this script nor `sharp`. Run it again
 * only when the source logo changes.
 *
 * The source is `source/logo_fnmt_30mm_bn.png`, from the PNG pack FNMT-RCM publishes at
 * https://www.fnmt.es/prensa/identidad-corporativa (the "reproducción en blanco y negro" variant),
 * unaltered. What is drawn from it: the logo as it is, and its emblem — the crowned M — alone, for
 * the places an app needs a square mark. Nothing is redrawn, recoloured or recomposed beyond that,
 * except a white copy of each for the dark theme.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "source", "logo_fnmt_30mm_bn.png");
/** The emblem's box in the source: the first run of ink, measured, not guessed. */
const EMBLEM = { left: 0, top: 0, width: 323, height: 392 };

/** The ink of a black-on-white image as an alpha mask, painted in one colour. */
const ink = async (input, colour) => {
  const { data, info } = await sharp(input)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rgba = Buffer.alloc(info.width * info.height * 4);
  for (let i = 0; i < info.width * info.height; i++) {
    rgba[i * 4] = colour;
    rgba[i * 4 + 1] = colour;
    rgba[i * 4 + 2] = colour;
    rgba[i * 4 + 3] = 255 - data[i * info.channels];
  }
  return sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();
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
for (const [qualifier, colour] of [
  ["", 0],
  ["-night", 255],
]) {
  const logo = await ink(source, colour);
  const emblem = await ink(emblemSource, colour);
  // In-app: the splash mark (160 dp) and the header's logo (161 dp wide), at xxhdpi.
  await (await centred(emblem, 480, 400, transparent))
    .png()
    .toFile(out(`drawable${qualifier}-xxhdpi`, "ic_logo_icon.png"));
  await sharp(logo)
    .resize({ width: 483 })
    .png()
    .toFile(out(`drawable${qualifier}-xxhdpi`, "ic_logo_icon_and_text.png"));
}

// The launcher icon: the black emblem on white. The adaptive foreground keeps to the 66 dp safe zone.
const emblem = await ink(emblemSource, 0);
for (const [density, scale] of [
  ["mdpi", 1],
  ["hdpi", 1.5],
  ["xhdpi", 2],
  ["xxhdpi", 3],
  ["xxxhdpi", 4],
]) {
  const foreground = Math.round(108 * scale);
  const legacy = Math.round(48 * scale);
  await (await centred(emblem, foreground, Math.round(54 * scale), transparent))
    .webp({ lossless: true })
    .toFile(out(`mipmap-${density}`, "ic_launcher_foreground.webp"));
  const square = await (await centred(emblem, legacy, Math.round(32 * scale), white))
    .png()
    .toBuffer();
  await sharp(square)
    .webp({ lossless: true })
    .toFile(out(`mipmap-${density}`, "ic_launcher.webp"));
  const circle = Buffer.from(
    `<svg width="${legacy}" height="${legacy}"><circle cx="${legacy / 2}" cy="${legacy / 2}" r="${legacy / 2}"/></svg>`,
  );
  await sharp(square)
    .composite([{ input: circle, blend: "dest-in" }])
    .webp({ lossless: true })
    .toFile(out(`mipmap-${density}`, "ic_launcher_round.webp"));
}
console.log("written", join(here, "res"));
