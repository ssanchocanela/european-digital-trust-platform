import { redact } from "@edtp/shared";

/**
 * A minimal structured logger for the console.
 *
 * Deliberately its own, and deliberately small. The platform API's logger lives in
 * `apps/platform-api/src/logging/` — app-local, not shared — and moving it into a package is a
 * refactor of the API that does not belong in a branch about a web interface. **This is noted as a
 * follow-up rather than left as a silent fork:** when a third process needs logging, the right move is
 * one `@edtp/logging` package and this file deleted.
 *
 * What it does share is the part that matters: `redact` from `@edtp/shared`, so the deny-list that
 * keeps credentials, tokens and attribute values out of the platform's logs applies here too. A console
 * logging a presentation result would be exactly the leak `CLAUDE.md` §5 forbids, and the console
 * handles results on every page.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

export type LogLevel = keyof typeof LEVELS;

export class Logger {
  constructor(private readonly level: LogLevel = "info") {}

  debug(message: string, context?: Record<string, unknown>): void {
    this.write("debug", message, context);
  }
  info(message: string, context?: Record<string, unknown>): void {
    this.write("info", message, context);
  }
  warn(message: string, context?: Record<string, unknown>): void {
    this.write("warn", message, context);
  }
  error(message: string, context?: Record<string, unknown>): void {
    this.write("error", message, context);
  }

  private write(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (LEVELS[level] < LEVELS[this.level]) {
      return;
    }
    const line = {
      time: new Date().toISOString(),
      level,
      service: "operator-console",
      message,
      ...(context ? (redact(context) as Record<string, unknown>) : {}),
    };
    process.stdout.write(`${JSON.stringify(line)}\n`);
  }
}
