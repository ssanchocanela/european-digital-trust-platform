/**
 * The sandbox's domain: participant organisations, people, membership and sign-in (ADR 0015). Pure.
 * It fills the platform's own model — a sandbox organisation is a platform `Tenant` — rather than
 * duplicating it.
 */
export * from "./people.js";
export * from "./quotas.js";
