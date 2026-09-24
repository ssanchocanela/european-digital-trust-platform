import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import * as schema from "./schema.js";

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseOptions {
  readonly connectionString: string;
  readonly ssl?: boolean;
  readonly maxConnections?: number;
  readonly statementTimeoutMs?: number;
}

export interface DatabaseHandle {
  readonly db: Database;
  readonly pool: Pool;
  close(): Promise<void>;
}

/**
 * Creates the connection pool and the query builder.
 *
 * All access is parameterised: every query in this package goes through the query
 * builder or uses bound parameters, and no string interpolation builds SQL anywhere.
 *
 * A statement timeout is set at the pool level so a pathological query cannot hold a
 * connection indefinitely and starve the rest of the application.
 */
export const createDatabase = (options: DatabaseOptions): DatabaseHandle => {
  const config: PoolConfig = {
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    ...(options.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
    statement_timeout: options.statementTimeoutMs ?? 10_000,
  };
  const pool = new Pool(config);
  const db = drizzle(pool, { schema });
  return {
    db,
    pool,
    close: async () => {
      await pool.end();
    },
  };
};

export { schema };
