import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Trust lists published by the portal: `GET /lote/<name>.jwt`.
 *
 * A wallet build reads each of its trust lists from one address. For a demonstration whose lists are
 * neither the reference environment's nor ours on GitHub Pages — a client's, handed over as files —
 * the portal is where they are published: it is public, it holds no secret, and a list is public
 * material by nature.
 *
 * **What is served is a file an operator put there, unchanged.** The portal signs nothing and
 * vouches for nothing: a list says who signed it, and a wallet decides whether to accept that. The
 * directory is mounted read-only; the portal cannot alter a list, only refuse to serve what does not
 * look like one. `TEST` only, like everything on this host.
 */

/** A file name and nothing else: no path, no dots but the extension's. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.jwt$/;
/** A notified list is tens of kilobytes. Anything far beyond that is not a list. */
const MAX_BYTES = 2 * 1024 * 1024;

const isCompactJws = (text: string): boolean => {
  const parts = text.trim().split(".");
  if (parts.length !== 3 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) return false;
  try {
    const header = JSON.parse(Buffer.from(parts[0] ?? "", "base64url").toString("utf8")) as {
      alg?: unknown;
    };
    return typeof header.alg === "string";
  } catch {
    return false;
  }
};

/** The list of that name, if the directory holds one that is a signed list in compact form. */
export const readTrustList = async (
  directory: string | undefined,
  name: string,
): Promise<string | undefined> => {
  if (!directory || !NAME.test(name)) return undefined;
  const path = join(directory, name);
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_BYTES) return undefined;
    const text = await readFile(path, "utf8");
    return isCompactJws(text) ? text.trim() : undefined;
  } catch {
    return undefined;
  }
};
