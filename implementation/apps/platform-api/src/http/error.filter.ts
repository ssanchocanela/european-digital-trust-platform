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

    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json({
        error: "http_error",
        message: exception.message,
        ...(correlationId ? { correlationId } : {}),
      } satisfies ErrorBody);
      return;
    }

    // An unexpected throw. The message may contain anything, including content, so it is
    // logged but never returned.
    this.logger.error("unhandled error", {
      correlationId,
      path: request.path,
      errorName: exception instanceof Error ? exception.name : typeof exception,
    });
    response.status(500).json({
      error: "internal_error",
      message: "An internal error occurred.",
      ...(correlationId ? { correlationId } : {}),
    } satisfies ErrorBody);
  }
}
