import { httpStatusFor, PlatformError } from "@edtp/shared";
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Inject,
} from "@nestjs/common";
import type { Response } from "express";
import { ZodError } from "zod";
import type { Logger } from "../logging/logger.js";
import { LOGGER_TOKEN } from "../tokens.js";
import type { ContextualRequest } from "./auth.js";

/**
 * The single error boundary.
 *
 * Produces one response shape for every failure and decides what a customer is allowed to
 * see. Validation detail is returned, because it is actionable and carries no content.
 * Anything else is reduced to a stable code and a short message, and the diagnostic detail
 * goes to the log — mirroring how the engine keeps certificate subjects, thumbprints and
 * configured trust-list URLs out of its own responses.
 */
export interface ErrorBody {
  readonly error: string;
  readonly message: string;
  readonly correlationId?: string;
  readonly details?: readonly { path?: string; code: string; message: string }[];
}

/**
 * PostgreSQL error codes the platform can answer meaningfully.
 *
 * Without this translation a unique index does its job at the database and the caller is told
 * "An internal error occurred" with a 500 — a server error for what is squarely a client
 * conflict. Found by running `scripts/smoke-vaas.sh` twice against the same database: the second
 * run's Relying Party registration violated
 * `relying_parties_identifier_key (registrar_assigned_identifier, trust_environment)` and
 * returned 500 with nothing actionable in it.
 *
 * Class 23 is "integrity constraint violation" (PostgreSQL Appendix A).
 */
const PG_UNIQUE_VIOLATION = "23505";
const PG_FOREIGN_KEY_VIOLATION = "23503";
const PG_NOT_NULL_VIOLATION = "23502";
const PG_CHECK_VIOLATION = "23514";

interface PostgresError {
  readonly code: string;
  readonly constraint?: string;
  readonly detail?: string;
  readonly table?: string;
}

const asPostgresError = (e: unknown): PostgresError | undefined => {
  if (typeof e !== "object" || e === null) return undefined;
  const code = (e as { code?: unknown }).code;
  if (typeof code !== "string") return undefined;
  const record = e as Record<string, unknown>;
  return {
    code,
    ...(typeof record.constraint === "string" ? { constraint: record.constraint } : {}),
    ...(typeof record.detail === "string" ? { detail: record.detail } : {}),
    ...(typeof record.table === "string" ? { table: record.table } : {}),
  };
};

/**
 * Maps an integrity violation to a platform error.
 *
 * The **constraint name** is returned to the caller, and nothing else. A constraint name is
 * schema metadata, chosen by us, and identifies which rule was broken — which is what makes the
 * response actionable. PostgreSQL's `detail` is deliberately *not* returned: it embeds the
 * offending values (`Key (registrar_assigned_identifier, trust_environment)=(...) already
 * exists`), and those values can be customer data.
 */
const platformErrorForPostgres = (pg: PostgresError): PlatformError | undefined => {
  const where = pg.constraint ? ` (${pg.constraint})` : "";
  switch (pg.code) {
    case PG_UNIQUE_VIOLATION:
      return PlatformError.conflict(
        "resource_already_exists",
        `A record violating a uniqueness rule${where} already exists.`,
      );
    case PG_FOREIGN_KEY_VIOLATION:
      return PlatformError.validation(
        "referenced_record_missing",
        `A referenced record does not exist, or is still referenced${where}.`,
      );
    case PG_NOT_NULL_VIOLATION:
    case PG_CHECK_VIOLATION:
      return PlatformError.validation(
        "record_violates_constraint",
        `The record violates a database constraint${where}.`,
      );
    default:
      return undefined;
  }
};

@Catch()
export class PlatformErrorFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER_TOKEN) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<ContextualRequest>();
    const response = http.getResponse<Response>();
    const correlationId = request.edtp?.correlationId;

    if (exception instanceof PlatformError) {
      const status = httpStatusFor(exception.kind);
      // 4xx is the caller's problem and is expected traffic; 5xx and engine failures are
      // ours and are logged at error level so they surface in monitoring.
      if (status >= 500) {
        this.logger.error("request failed", {
          correlationId,
          code: exception.code,
          kind: exception.kind,
          path: request.path,
        });
      } else {
        this.logger.debug("request rejected", {
          correlationId,
          code: exception.code,
          kind: exception.kind,
          path: request.path,
        });
      }
      response.status(status).json({
        error: exception.code,
        message: exception.message,
        ...(correlationId ? { correlationId } : {}),
        // Only validation and unprocessable errors carry their detail outward. A conflict
        // or engine error's detail is diagnostic and stays in the log.
        ...(exception.kind === "VALIDATION" || exception.kind === "UNPROCESSABLE"
          ? { details: exception.details }
          : {}),
      } satisfies ErrorBody);
      return;
    }

    if (exception instanceof ZodError) {
      response.status(400).json({
        error: "invalid_request",
        message: "The request body or parameters are invalid.",
        ...(correlationId ? { correlationId } : {}),
        details: exception.issues.map((i) => ({
          path: i.path.join("."),
          code: i.code,
          message: i.message,
        })),
      } satisfies ErrorBody);
      return;
    }

    // Integrity violations are the caller's problem, not ours. Translated before the
    // unhandled-error branch so a unique index produces a 409 rather than a 500.
    const pg = asPostgresError(exception);
    if (pg) {
      const translated = platformErrorForPostgres(pg);
      if (translated) {
        this.logger.debug("request rejected by a database constraint", {
          correlationId,
          path: request.path,
          pgCode: pg.code,
          constraint: pg.constraint,
          table: pg.table,
        });
        response.status(httpStatusFor(translated.kind)).json({
          error: translated.code,
          message: translated.message,
          ...(correlationId ? { correlationId } : {}),
        } satisfies ErrorBody);
        return;
      }
    }

    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json({
        error: "http_error",
        message: exception.message,
        ...(correlationId ? { correlationId } : {}),
      } satisfies ErrorBody);
      return;
    }

    // An unexpected throw. The message may contain anything, including content, so it is
    // never *returned* — but it must still be logged, or the 500 is undiagnosable. Logging only
    // the error's class name, as this did originally, made a live failure impossible to
    // diagnose: `{"errorName":"Error"}` says nothing about what broke.
    //
    // Safety comes from the logger, which passes every field through the shared redaction
    // deny-list, so a message or stack frame carrying a denied key is stripped there rather
    // than here. The stack is capped because a deep stack is noise, not information.
    this.logger.error("unhandled error", {
      correlationId,
      path: request.path,
      errorName: exception instanceof Error ? exception.name : typeof exception,
      errorMessage: exception instanceof Error ? exception.message : String(exception),
      ...(pg ? { pgCode: pg.code, constraint: pg.constraint, table: pg.table } : {}),
      stack:
        exception instanceof Error && exception.stack
          ? exception.stack.split("\n").slice(0, 8).join("\n")
          : undefined,
    });
    response.status(500).json({
      error: "internal_error",
      message: "An internal error occurred.",
      ...(correlationId ? { correlationId } : {}),
    } satisfies ErrorBody);
  }
}
