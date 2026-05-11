export interface Logger {
  debug(message: string, metadata?: unknown): void;
  info(message: string, metadata?: unknown): void;
  warn(message: string, metadata?: unknown): void;
  error(message: string, metadata?: unknown): void;
}

export type ReaderSyncLogLevel = "debug" | "info" | "warn" | "error";

export interface ReaderSyncLogEntry {
  id: string;
  timestamp: string;
  level: ReaderSyncLogLevel;
  scope: string;
  message: string;
  metadata?: unknown;
  location?: string;
  userAgent?: string;
}

export type ReaderSyncLogSink = (entry: ReaderSyncLogEntry) => void;

const localLogBufferLimit = 400;
const localLogBuffer: ReaderSyncLogEntry[] = [];
let logSink: ReaderSyncLogSink | null = null;
let logSequence = 0;

function sanitizeMetadata(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (depth >= 4) {
    return "[MaxDepth]";
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack
    };
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 80).map((item) => sanitizeMetadata(item, depth + 1));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
      output[key] = sanitizeMetadata(nestedValue, depth + 1);
    }
    return output;
  }
  return String(value);
}

function resolveLocation(): string | undefined {
  try {
    return globalThis.location?.href;
  } catch {
    return undefined;
  }
}

function resolveUserAgent(): string | undefined {
  try {
    return globalThis.navigator?.userAgent;
  } catch {
    return undefined;
  }
}

export function setReaderSyncLogSink(sink: ReaderSyncLogSink | null, options?: { flushExisting?: boolean }): void {
  logSink = sink;
  if (sink && options?.flushExisting !== false) {
    for (const entry of localLogBuffer) {
      sink(entry);
    }
  }
}

export function getReaderSyncLocalLogs(): ReaderSyncLogEntry[] {
  return [...localLogBuffer];
}

function log(level: "debug" | "info" | "warn" | "error", scope: string, message: string, metadata?: unknown): void {
  const prefix = `[reader-sync:${scope}]`;
  if (metadata === undefined) {
    console[level](`${prefix} ${message}`);
  } else {
    console[level](`${prefix} ${message}`, metadata);
  }

  const entry: ReaderSyncLogEntry = {
    id: `${Date.now()}-${++logSequence}`,
    timestamp: new Date().toISOString(),
    level,
    scope,
    message,
    location: resolveLocation(),
    userAgent: resolveUserAgent()
  };
  if (metadata !== undefined) {
    entry.metadata = sanitizeMetadata(metadata);
  }
  localLogBuffer.push(entry);
  if (localLogBuffer.length > localLogBufferLimit) {
    localLogBuffer.splice(0, localLogBuffer.length - localLogBufferLimit);
  }
  try {
    logSink?.(entry);
  } catch (error) {
    console.warn(`${prefix} log sink failed`, error);
  }
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
