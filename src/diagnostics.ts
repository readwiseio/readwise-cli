import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { VERSION } from "./version.js";

const DEBUG_ENV_VALUES = new Set(["1", "true", "yes", "on"]);
const DEBUG_PREFIX = "[readwise-cli debug] ";
const SENSITIVE_KEYS = [
  "access_token",
  "refresh_token",
  "client_secret",
  "code_verifier",
  "authorization",
  "password",
  "token",
];
const SENSITIVE_TEXT_KEYS = [
  ...SENSITIVE_KEYS,
  "code",
];

export interface SanitizedError {
  name: string;
  message: string;
  code?: string;
  status?: number;
  statusText?: string;
  type?: string;
  cause?: SanitizedError;
}

interface DiagnosticsOptions {
  enabled: boolean;
  runId: string;
  cliVersion: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  write: (line: string) => void;
  now: () => number;
}

type DebugFields = Record<string, unknown>;

export function isDebugRequested(
  argv: string[] = process.argv,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return argv.includes("--debug") || DEBUG_ENV_VALUES.has((env.READWISE_CLI_DEBUG ?? "").toLowerCase());
}

export function sanitizeText(value: string): string {
  const keyAlternation = SENSITIVE_TEXT_KEYS.join("|");
  let sanitized = value;

  sanitized = sanitized.replace(
    /(Authorization\s*:\s*(?:Bearer|Token|Basic)\s+)[^,\s)]+/gi,
    "$1[REDACTED]",
  );
  sanitized = sanitized.replace(
    new RegExp(`\\b(${keyAlternation})=([^&\\s,;]+)`, "gi"),
    "$1=[REDACTED]",
  );
  sanitized = sanitized.replace(
    new RegExp(`"(${keyAlternation})"\\s*:\\s*"[^"]*"`, "gi"),
    '"$1":"[REDACTED]"',
  );

  return sanitized;
}

export function sanitizeError(error: unknown, depth = 0): SanitizedError {
  const record = typeof error === "object" && error !== null ? error as Record<string, unknown> : undefined;
  const name = error instanceof Error
    ? error.name
    : typeof record?.name === "string"
      ? record.name
      : record
        ? "Object"
        : typeof error;
  const rawMessage = error instanceof Error
    ? error.message
    : typeof record?.message === "string"
      ? record.message
      : String(error);
  const sanitized: SanitizedError = {
    name,
    message: sanitizeText(rawMessage),
  };

  if (typeof record?.code === "string" || typeof record?.code === "number") {
    sanitized.code = sanitizeText(String(record.code));
  }
  if (typeof record?.status === "number") {
    sanitized.status = record.status;
  }
  if (typeof record?.statusText === "string") {
    sanitized.statusText = sanitizeText(record.statusText);
  }
  if (typeof record?.type === "string") {
    sanitized.type = sanitizeText(record.type);
  }
  if (depth === 0 && record?.cause !== undefined) {
    sanitized.cause = sanitizeError(record.cause, depth + 1);
  }

  return sanitized;
}

function sanitizeDebugValue(key: string, value: unknown, depth = 0): unknown {
  if (value === undefined) return undefined;
  if (SENSITIVE_KEYS.includes(key.toLowerCase())) return "[REDACTED]";
  if (typeof value === "string") return sanitizeText(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (depth >= 3) return "[REDACTED]";
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDebugValue(key, item, depth + 1));
  }
  if (typeof value === "object") {
    const sanitized: DebugFields = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const redacted = sanitizeDebugValue(childKey, childValue, depth + 1);
      if (redacted !== undefined) sanitized[childKey] = redacted;
    }
    return sanitized;
  }
  return String(value);
}

function sanitizeFields(fields: DebugFields): DebugFields {
  const sanitized: DebugFields = {};
  for (const [key, value] of Object.entries(fields)) {
    const redacted = sanitizeDebugValue(key, value);
    if (redacted !== undefined) sanitized[key] = redacted;
  }
  return sanitized;
}

export function createDiagnostics(options: DiagnosticsOptions) {
  let started = false;

  const emit = (event: string, fields: DebugFields = {}) => {
    if (!options.enabled) return;
    const payload = {
      event,
      run_id: options.runId,
      ...sanitizeFields(fields),
    };
    options.write(`${DEBUG_PREFIX}${JSON.stringify(payload)}\n`);
  };

  return {
    enabled: options.enabled,
    runId: options.runId,

    start(): void {
      if (started) return;
      started = true;
      emit("cli_start", {
        cli_version: options.cliVersion,
        node_version: options.nodeVersion,
        platform: options.platform,
        arch: options.arch,
      });
    },

    log(event: string, fields: DebugFields = {}): void {
      emit(event, fields);
    },

    error(phase: string, error: unknown, fields: DebugFields = {}): void {
      if (!options.enabled) return;
      emit("error", {
        phase,
        ...fields,
        error: sanitizeError(error),
      });
    },

    async phase<T>(phase: string, operation: () => Promise<T> | T, fields: DebugFields = {}): Promise<T> {
      if (!options.enabled) {
        return await operation();
      }

      const startedAt = options.now();
      emit("phase_start", { phase, ...fields });
      try {
        const result = await operation();
        emit("phase_end", {
          phase,
          ...fields,
          duration_ms: Math.round(Math.max(0, options.now() - startedAt)),
        });
        return result;
      } catch (error) {
        emit("phase_error", {
          phase,
          ...fields,
          duration_ms: Math.round(Math.max(0, options.now() - startedAt)),
          error: sanitizeError(error),
        });
        throw error;
      }
    },
  };
}

export const diagnostics = createDiagnostics({
  enabled: isDebugRequested(),
  runId: randomUUID(),
  cliVersion: VERSION,
  nodeVersion: process.version,
  platform: process.platform,
  arch: process.arch,
  write: (line) => process.stderr.write(line),
  now: () => performance.now(),
});
