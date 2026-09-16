import type { DocumentBuilder } from "@nestjs/swagger";

/**
 * The business API's OpenAPI description, in one place.
 *
 * Two callers: `main.ts`, which serves it at `/openapi`, and `openapi-cli.ts`, which writes it to a
 * file so the contract can be diffed in review. A second copy of this text is how the served
 * document and the checked-in one start describing different APIs — the same drift this codebase has
 * been bitten by three times at the engine boundary.
 *
 * The description says what the contract is **not**, deliberately. `CLAUDE.md` §3.3 keeps DCQL,
 * OpenID4VP and engine sessions out of the customer-facing model, and §2 forbids claiming
 * conformance or production readiness anywhere — including here, which is the one piece of prose a
 * customer reads before anything else.
 */
export const openApiConfig = (builder: DocumentBuilder) =>
  builder
    .setTitle("European Digital Trust Platform — Verification as a Service")
    .setDescription(
      "V0 business API. Customers work with presentation policies and transactions; " +
        "protocol details (DCQL, OpenID4VP, engine sessions) are not part of this contract. " +
        "No ARF or Technical Specification conformance and no production readiness is claimed.",
    )
    .setVersion("0.1.0")
    .addBearerAuth({ type: "http", scheme: "bearer", description: "Tenant API key" })
    .build();
