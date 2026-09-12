import { PlatformError } from "@edtp/shared";

/**
 * Keyset pagination for the list endpoints.
 *
 * ## Why keyset and not `OFFSET`
 *
 * `OFFSET` is wrong here for two independent reasons, and the second is the one that matters.
 *
 * It degrades: the database still walks the skipped rows, so page 500 costs 500 pages of work. That is
 * merely slow. The real problem is that these collections are **ordered by creation time descending**
 * and rows are inserted continuously — a presentation is created every time someone starts one. With
 * `OFFSET`, a row inserted between two requests shifts every subsequent page by one, so a caller
 * walking the list silently **skips** a record. A list endpoint that quietly omits rows is worse than
 * no list endpoint, because nobody notices.
 *
 * Keyset asks for "the page after this exact row", so an insertion changes nothing about what follows.
 *
 * ## The cursor is opaque, and deliberately so
 *
 * It encodes `(createdAt, id)` — the sort key, which must be unique or ties can drop or repeat rows,
 * hence the id as a tiebreaker. It is base64url, not encrypted and not signed: it carries nothing
 * secret, and a caller who forges one sees only rows their own tenant already permits. What it must
 * **not** be is a documented `{createdAt, id}` object, because that would become a contract; opacity is
 * what leaves us free to change the sort key later.
 */

/** The default and the ceiling. A caller asking for more gets `page_size_too_large`, not a silent clamp. */
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export interface PageRequest {
  readonly limit: number;
  readonly cursor?: PageCursor;
}

export interface PageCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export interface Page<T> {
  readonly items: readonly T[];
  /**
   * Absent when there is no next page.
   *
   * Determined by fetching `limit + 1` rows and discarding the extra, rather than by a second
   * `COUNT(*)`: a count on a growing table is both expensive and immediately stale, and "is there
   * more" is the only question a caller can act on.
   */
  readonly nextCursor?: string;
}

/**
 * Parses `limit` and `cursor` from query parameters.
 *
 * Rejects rather than coerces. A `limit=abc` that silently became 25 would make a caller believe they
 * had asked for something they had not, and `limit=100000` silently clamped to 100 is how a client ends
 * up looping for ever on a page it thinks is the last.
 */
export const parsePageRequest = (query: { limit?: unknown; cursor?: unknown }): PageRequest => {
  let limit = DEFAULT_PAGE_SIZE;
  if (query.limit !== undefined && query.limit !== "") {
    const raw = Number(query.limit);
    if (!Number.isInteger(raw) || raw < 1) {
      throw PlatformError.validation("invalid_page_size", "limit must be a positive integer.", [
        { path: "limit", code: "invalid_limit", message: "expected a positive integer" },
      ]);
    }
    if (raw > MAX_PAGE_SIZE) {
      throw PlatformError.validation(
        "page_size_too_large",
        `limit must be ${MAX_PAGE_SIZE} or fewer.`,
        [{ path: "limit", code: "limit_too_large", message: `maximum is ${MAX_PAGE_SIZE}` }],
      );
    }
    limit = raw;
  }

  if (query.cursor === undefined || query.cursor === "") {
    return { limit };
  }
  if (typeof query.cursor !== "string") {
    throw invalidCursor();
  }
  return { limit, cursor: decodeCursor(query.cursor) };
};

export const encodeCursor = (cursor: PageCursor): string =>
  Buffer.from(`${cursor.createdAt.toISOString()}|${cursor.id}`, "utf8").toString("base64url");

const decodeCursor = (raw: string): PageCursor => {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    throw invalidCursor();
  }
  const separator = decoded.indexOf("|");
  if (separator <= 0) {
    throw invalidCursor();
  }
  const createdAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (Number.isNaN(createdAt.getTime()) || id.length === 0) {
    throw invalidCursor();
  }
  return { createdAt, id };
};

/**
 * One message for every malformed cursor.
 *
 * A caller cannot act on the difference between "not base64" and "the timestamp did not parse", and a
 * detailed message would describe the cursor's internals — which are exactly what opacity protects.
 */
const invalidCursor = (): PlatformError =>
  PlatformError.validation(
    "invalid_cursor",
    "The cursor is not valid. Omit it to start over.",
    [{ path: "cursor", code: "invalid_cursor", message: "not a cursor issued by this API" }],
  );

/**
 * Turns `limit + 1` rows into a page.
 *
 * Callers fetch one extra row and pass it here, so "is there a next page" costs nothing beyond the row
 * itself.
 */
export const toPage = <T>(
  rows: readonly T[],
  limit: number,
  keyOf: (row: T) => PageCursor,
): Page<T> => {
  if (rows.length <= limit) {
    return { items: rows };
  }
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  // `items` is non-empty here: `rows.length > limit >= 1`.
  return { items, nextCursor: encodeCursor(keyOf(last as T)) };
};
