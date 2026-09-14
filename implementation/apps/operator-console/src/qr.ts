import qrcode from "qrcode-generator";
import { escapeHtml, rawHtml, type SafeHtml } from "./html.js";

/**
 * Server-side QR rendering, as inline SVG.
 *
 * ## Why a library, and why this one
 *
 * A hand-rolled encoder is about six hundred lines of Reed–Solomon and mask selection, and the failure
 * mode when it is subtly wrong is a code that **looks** fine and will not scan. That is precisely the
 * class of failure this console exists to remove from a wallet test, so it would be a strange place to
 * introduce it.
 *
 * `qrcode-generator` is Kazuhiko Arase's original implementation — the one most other libraries are
 * ports of — with **zero transitive dependencies**. The more obvious `qrcode` package pulls in
 * `yargs@15` for a CLI we would never run, which is a poor trade on a project that takes dependency
 * scanning seriously (`CLAUDE.md` §9).
 *
 * ## Why SVG, inline
 *
 * No canvas, no data URL, no image request. The markup is in the page, so it renders with no script and
 * no second round trip — and a QR that depends on JavaScript is a QR that is occasionally not there
 * when a phone is already in someone's hand.
 */

/**
 * Error correction level `M`, the usual choice: ~15% recovery, and it keeps the code small enough to
 * stay scannable on a laptop screen. An OpenID4VP request URI is long, so `H` would push the module
 * count up for no practical gain at arm's length.
 */
const ERROR_CORRECTION = "M";

/** `0` lets the library pick the smallest version that fits the data. */
const AUTOMATIC_VERSION = 0;

export interface QrResult {
  readonly svg: SafeHtml;
  /** The module count, reported so a caller can say how dense the code is. */
  readonly modules: number;
}

/**
 * Renders `value` as an SVG QR code.
 *
 * Throws when the value does not fit even at version 40. That is a real condition for OpenID4VP: a
 * request passed *by value* rather than by reference can exceed the format, which is one reason the
 * engine uses `request_uri`. A throw is right — a truncated QR would be worse than no QR.
 */
export const renderQr = (value: string, cellSize = 5): QrResult => {
  const qr = qrcode(AUTOMATIC_VERSION, ERROR_CORRECTION);
  qr.addData(value);
  try {
    qr.make();
  } catch (cause) {
    throw new Error(
      `the value does not fit in a QR code (${value.length} characters). A QR cannot carry an ` +
        "OpenID4VP request passed by value; it needs a `request_uri`.",
      { cause },
    );
  }

  // `createSvgTag` emits a `<svg>` with a `<path>` of modules and no script, no external reference and
  // no attribute derived from the input — the data is encoded as geometry. Safe to inline, and the one
  // `rawHtml` call in the console that is not authored markup.
  const svg = qr.createSvgTag({ cellSize, margin: 2, scalable: true });
  return { svg: rawHtml(svg), modules: qr.getModuleCount() };
};

/**
 * A QR plus the text it encodes, for an operator who needs to check it or copy it.
 *
 * The URI is shown **and** escaped: it is a value the engine produced, not a constant, and it reaches
 * the page as text.
 */
export const renderQrWithValue = (value: string, label: string): SafeHtml => {
  const { svg, modules } = renderQr(value);
  return rawHtml(
    `<figure class="qr"><div class="qr-svg">${svg.__safe}</div>` +
      `<figcaption>${escapeHtml(label)} — ${modules}×${modules} modules</figcaption>` +
      `<textarea class="qr-value" readonly rows="3" spellcheck="false">${escapeHtml(value)}</textarea>` +
      `</figure>`,
  );
};
