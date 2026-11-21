#!/usr/bin/env node
/**
 * Draws the NTT DATA brand's wallet resources from the organisation's own logo.
 *
 *   npm install --no-save sharp && node tools/test-wallet/brands/nttdata/make-assets.mjs
 *
 * The output, `res/`, is committed, so a build needs neither this script nor `sharp`. Run it again
 * only when the source logo changes.
 *
 * The source is `source/nttdata-logo-futureblue.png`, the Future Blue logo on a transparent
 * background, as NTT DATA provided it, unaltered. What is drawn from it: the logo as it is, and its
 * emblem — the ring on the left — alone, for the places an app needs a square mark. The emblem's box is
 * measured from the image, not guessed: the first run of columns with ink, and the rows those columns
 * use. Nothing is redrawn or recomposed beyond that, except a white copy of each for the dark theme.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = process.env.BRAND_DIR ?? dirname(fileURLToPath(import.meta.url));
const source = join(here, "source", "nttdata-logo-futureblue.png");

/** The emblem's box: the first run of columns that carry ink, and the rows they use. */
const measureEmblem = async (input) => {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const inked = (x, y) => data[(y * info.width + x) * 4 + 3] > 20;
  const column = (x) => {
    for (let y = 0; y < info.height; y++) if (inked(x, y)) return true;
    return false;
  };
  let left = 0;
  while (left < info.width && !column(left)) left++;
  let right = left;
  while (right < info.width && column(right)) right++;
  let top = info.height;
  let bottom = 0;
  for (let x = left; x < right; x++) {
    for (let y = 0; y < info.height; y++) {
      if (!inked(x, y)) continue;
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  return { left, top, width: right - left, height: bottom - top + 1 };
};

/** The image's ink, painted white, keeping its edges: for the dark theme. */
const white = async (input) => {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < info.width * info.height; i++) {
    data[i * 4] = 255;
    data[i * 4 + 1] = 255;
    data[i * 4 + 2] = 255;
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();
};

const out = (...parts) => {
  const path = join(here, "res", ...parts);
  mkdirSync(dirname(path), { recursive: true });
  return path;
};
const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
const whiteBackground = { r: 255, g: 255, b: 255, alpha: 1 };

/** `mark` scaled to fit `inner` pixels, centred on a `size` square of `background`. */
const centred = async (mark, size, inner, background) => {
  const scaled = await sharp(mark).resize(inner, inner, { fit: "inside" }).toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background } }).composite([
    { input: scaled, gravity: "centre" },
  ]);
};

const box = await measureEmblem(source);
console.log("emblem", box);
const logoSource = await sharp(source).trim().png().toBuffer();
const emblemSource = await sharp(source).extract(box).png().toBuffer();

for (const [qualifier, paint] of [
  ["", async (b) => b],
  ["-night", white],
]) {
  const logo = await paint(logoSource);
  const emblem = await paint(emblemSource);
  // In-app: the splash mark (160 dp) and the header's logo (161 dp wide), at xxhdpi.
  await (await centred(emblem, 480, 400, transparent))
    .png()
    .toFile(out(`drawable${qualifier}-xxhdpi`, "ic_logo_icon.png"));
  await sharp(logo)
    .resize({ width: 483 })
    .png()
    .toFile(out(`drawable${qualifier}-xxhdpi`, "ic_logo_icon_and_text.png"));
}

// The launcher icon: the blue emblem on white. The adaptive foreground keeps to the 66 dp safe zone.
for (const [density, scale] of [
  ["mdpi", 1],
  ["hdpi", 1.5],
  ["xhdpi", 2],
  ["xxhdpi", 3],
  ["xxxhdpi", 4],
]) {
  const foreground = Math.round(108 * scale);
  const legacy = Math.round(48 * scale);
  await (await centred(emblemSource, foreground, Math.round(54 * scale), transparent))
    .webp({ lossless: true })
    .toFile(out(`mipmap-${density}`, "ic_launcher_foreground.webp"));
  const square = await (await centred(emblemSource, legacy, Math.round(32 * scale), whiteBackground))
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
