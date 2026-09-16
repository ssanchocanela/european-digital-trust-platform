/**
 * Server-rendered HTML, with escaping by default.
 *
 * A tagged template rather than a template engine. The reason is not dependency count: it is that
 * every engine has an *unescaped* form, and the difference between `{{x}}` and `{{{x}}}` is one
 * character standing between an attribute value and stored XSS. Here the only way to emit unescaped
 * markup is to pass a value that is already `SafeHtml`, which the type system makes visible at the
 * call site.
 *
 * Values that reach these templates include a policy's `purpose` and an intended use's trade name —
 * text a customer supplies. Treating them as untrusted is not theoretical.
 */

/** Markup that has already been escaped, or was authored here. */
export type SafeHtml = { readonly __safe: string };

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Escapes the five characters that matter in both element content and quoted attribute values.
 *
 * `'` is included because an attribute written with single quotes is legal HTML, and a template
 * author who writes one should not create a hole.
 */
export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

const render = (value: unknown): string => {
  if (value === null || value === undefined || value === false) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.map(render).join("");
  }
  if (typeof value === "object" && "__safe" in (value as Record<string, unknown>)) {
    return (value as SafeHtml).__safe;
  }
  return escapeHtml(String(value));
};

/** Interpolations are escaped unless they are already `SafeHtml`. */
export const html = (
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
): SafeHtml => {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i += 1) {
    out += render(values[i]) + (strings[i + 1] ?? "");
  }
  return { __safe: out };
};

/**
 * Marks a string as safe.
 *
 * Deliberately verbose, and deliberately the only escape hatch: a search for `rawHtml(` lists every
 * place in the console where escaping was skipped. Never call it on anything that came from a request,
 * an API response, or a configuration value.
 */
export const rawHtml = (value: string): SafeHtml => ({ __safe: value });

export const toHtmlString = (value: SafeHtml): string => value.__safe;
