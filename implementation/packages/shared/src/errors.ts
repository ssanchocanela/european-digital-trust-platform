/**
 * Platform error taxonomy.
 *
 * Errors carry a stable machine-readable `code` and a short, safe `message`.
 * Diagnostic detail goes in `details` and is logged but never returned verbatim
 * to a customer unless the error kind is a validation error, where the detail is
 * the point.
 */
export type PlatformErrorKind =
  | "VALIDATION" // 400 — malformed input
  | "UNPROCESSABLE" // 422 — well-formed but rejected by a domain rule
  | "UNAUTHENTICATED" // 401
  | "FORBIDDEN" // 403 — includes cross-tenant access
  | "NOT_FOUND" // 404
  | "CONFLICT" // 409 — illegal state transition, duplicate
  | "ENGINE" // 502 — the wrapped engine failed or timed out
  | "INTERNAL"; // 500

export interface PlatformErrorDetail {
  readonly path?: string;
  readonly code: string;
  readonly message: string;
}

export class PlatformError extends Error {
  readonly kind: PlatformErrorKind;
  readonly code: string;
  readonly details: readonly PlatformErrorDetail[];

  constructor(
    kind: PlatformErrorKind,
    code: string,
    message: string,
    details: readonly PlatformErrorDetail[] = [],
  ) {
    super(message);
    this.name = "PlatformError";
    this.kind = kind;
    this.code = code;
    this.details = details;
  }

  static validation(
    code: string,
    message: string,
    details: readonly PlatformErrorDetail[] = [],
  ) {
    return new PlatformError("VALIDATION", code, message, details);
  }

  static unprocessable(
    code: string,
    message: string,
    details: readonly PlatformErrorDetail[] = [],
  ) {
    return new PlatformError("UNPROCESSABLE", code, message, details);
  }

  static unauthenticated(message = "Missing or invalid credentials.") {
    return new PlatformError("UNAUTHENTICATED", "unauthenticated", message);
  }

  static forbidden(code: string, message: string) {
    return new PlatformError("FORBIDDEN", code, message);
  }

  static notFound(resource: string) {
    return new PlatformError("NOT_FOUND", "not_found", `${resource} was not found.`);
  }

  static conflict(code: string, message: string) {
    return new PlatformError("CONFLICT", code, message);
  }

  static engine(code: string, message: string, details: readonly PlatformErrorDetail[] = []) {
    return new PlatformError("ENGINE", code, message, details);
  }

  static internal(code: string, message = "An internal error occurred.") {
    return new PlatformError("INTERNAL", code, message);
  }
}

export const httpStatusFor = (kind: PlatformErrorKind): number => {
  switch (kind) {
    case "VALIDATION":
      return 400;
    case "UNAUTHENTICATED":
      return 401;
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
      return 409;
    case "UNPROCESSABLE":
      return 422;
    case "ENGINE":
      return 502;
    case "INTERNAL":
      return 500;
  }
};
