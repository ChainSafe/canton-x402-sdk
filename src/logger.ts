// Canton x402 SDK -- Structured Logger

/**
 * Logger interface for SDK consumers to inject their own logging.
 */
export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/** Sensitive field names that should be redacted in log output. */
const SENSITIVE_FIELDS = new Set([
  "secret",
  "clientSecret",
  "client_secret",
  "password",
  "token",
  "access_token",
  "privateKey",
  "private_key",
  "authorization",
]);

/**
 * Redact sensitive fields from a data object (shallow, one level deep).
 */
export function redactSensitive(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (SENSITIVE_FIELDS.has(key)) {
      result[key] = "[REDACTED]";
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * JSON structured logger — outputs one JSON object per line.
 * Redacts sensitive fields automatically.
 */
export class JsonLogger implements Logger {
  private component: string;

  constructor(component = "canton-x402-sdk") {
    this.component = component;
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log("debug", message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log("info", message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log("warn", message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log("error", message, data);
  }

  private log(
    level: string,
    message: string,
    data?: Record<string, unknown>,
  ): void {
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      component: this.component,
      msg: message,
    };
    if (data) {
      Object.assign(entry, redactSensitive(data));
    }
    console.log(JSON.stringify(entry));
  }
}

/** No-op logger — discards all messages (default for library use). */
export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
