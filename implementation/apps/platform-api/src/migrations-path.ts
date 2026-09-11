import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Resolves the checked-in migrations directory.
 *
 * Resolved through the persistence package's own entry point rather than by a relative
 * path from this app, so it works the same whether the app runs from `dist/` or from
 * source, and stays correct if the layout changes.
 */
export const migrationsPath = (): string => {
  const require = createRequire(__filename);
  const entry = require.resolve("@edtp/persistence");
  // <pkg>/dist/index.js -> <pkg>/migrations
  return join(dirname(dirname(entry)), "migrations");
};
