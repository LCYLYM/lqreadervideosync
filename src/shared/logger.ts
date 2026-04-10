export interface Logger {
  debug(message: string, metadata?: unknown): void;
  info(message: string, metadata?: unknown): void;
  warn(message: string, metadata?: unknown): void;
  error(message: string, metadata?: unknown): void;
}

function log(level: "debug" | "info" | "warn" | "error", scope: string, message: string, metadata?: unknown): void {
  const prefix = `[reader-sync:${scope}]`;
  if (metadata === undefined) {
    console[level](`${prefix} ${message}`);
    return;
  }
  console[level](`${prefix} ${message}`, metadata);
}

export function createLogger(scope: string): Logger {
  return {
    debug(message, metadata) {
      log("debug", scope, message, metadata);
    },
    info(message, metadata) {
      log("info", scope, message, metadata);
    },
    warn(message, metadata) {
      log("warn", scope, message, metadata);
    },
    error(message, metadata) {
      log("error", scope, message, metadata);
    }
  };
}
