-- Engine tenant credentials created at runtime (sandbox G-6).
--
-- Until now every engine tenant's client came from `ENGINE_TENANT_CREDENTIALS` in the environment,
-- and a new one needed an operator to edit it and restart the API. The sandbox creates engine tenants
-- on demand, so their clients are kept here instead. The secret is encrypted with AES-256-GCM under
-- `ENGINE_CREDENTIALS_KEY`, which never enters the database: a dump yields no usable credential. The
-- environment variable keeps working and takes precedence.

CREATE TABLE IF NOT EXISTS "engine_tenant_credentials" (
  "engine_tenant_ref" text PRIMARY KEY,
  "client_id" text NOT NULL,
  -- base64url of nonce (12 bytes) || ciphertext || tag (16 bytes)
  "client_secret_sealed" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL
);
