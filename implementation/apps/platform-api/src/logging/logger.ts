import { redact } from "@edtp/shared";

/**
 * Structured JSON logger.
 *
 * Every field passes through the shared redaction deny-list before it is serialised, so
 * the privacy rule is enforced by the only code path that can emit a log line rather
 * than by reviewer discipline. `redaction.test.ts` and `logger.test.ts` fail the build if
 * a denied key survives.
 *
 * Deliberately hand-rolled rather than a logging framework: the requirement is one JSON
 * line per event with a correlation id and a mandatory redaction step, and a framework
 * would add a configuration surface where redaction could be bypassed.
 */
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogContext {
  readonly correlationId?: string;
  readonly tenantId?: string;
  readonly presentationId?: string;
  readonly policyId?: string;
  readonly policyVersion?: number;
  readonly [key: string]: unknown;
}

export interface LogSink {
  write(line: string): void;
}

const stdoutSink: LogSink = {
  write: (line) => {
    process.stdout.write(`${line}\n`);
  },
};

export class Logger {
  constructor(
    private readonly level: LogLevel = "info",
    private readonly sink: LogSink = stdoutSink,
    private readonly base: LogContext = {},
  ) {}

  /** A child logger carrying additional context, e.g. a per-request correlation id. */
  child(context: LogContext): Logger {
    return new Logger(this.level, this.sink, { ...this.base, ...context });
  }

  debug(message: string, context?: LogContext): void {
    this.emit("debug", message, context);
  }
  info(message: string, context?: LogContext): void {
    this.emit("info", message, context);
  }
  warn(message: string, context?: LogContext): void {
    this.emit("warn", message, context);
  }
  error(message: string, context?: LogContext): void {
    this.emit("error", message, context);
  }

  private emit(level: LogLevel, message: string, context?: LogContext): void {
    if (SEVERITY[level] < SEVERITY[this.level]) return;
    const merged = { ...this.base, ...context };
    // Redaction happens here, once, on the whole record. There is no code path that
    // writes a log line without passing through it.
    const safe = redact(merged) as Record<string, unknown>;
    this.sink.write(
      JSON.stringify({
        at: new Date().toISOString(),
        level,
        message,
        ...safe,
      }),
    );
  }
}

export const LOGGER = Symbol("Logger");
