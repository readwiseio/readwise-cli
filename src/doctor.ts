import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { sep } from "node:path";
import { Command } from "commander";
import { ensureValidToken } from "./auth.js";
import {
  getConfigPath,
  getConfigValue,
  isCacheValid,
  TOOLS_CACHE_VERSION,
  type Config,
  type ToolDef,
} from "./config.js";
import { diagnostics, sanitizeError, type SanitizedError } from "./diagnostics.js";
import { getTools } from "./mcp.js";
import { VERSION } from "./version.js";

type CheckStatus = "ok" | "warning" | "error" | "skipped";
type OverallStatus = "ok" | "warning" | "error";

interface Check {
  name: string;
  status: CheckStatus;
  message: string;
  duration_ms?: number;
  error?: SanitizedError;
}

interface ConfigFileState {
  path: string;
  exists: boolean;
  readable: boolean;
  valid_json: boolean;
  error?: SanitizedError;
}

interface AuthState {
  status: "not_logged_in" | "token" | "oauth";
  has_access_token: boolean;
  has_refresh_token: boolean;
  has_client_credentials: boolean;
  expires_at?: string;
  expired?: boolean;
  expires_within_60s?: boolean;
}

interface ToolsCacheState {
  present: boolean;
  valid: boolean;
  version?: number;
  expected_version: number;
  fetched_at?: string;
  age_ms?: number;
  tool_count?: number;
  read_only_tool_count?: number;
  annotated_tool_count?: number;
}

interface DoctorDeps {
  now: () => number;
  readConfigFile: () => Promise<{ state: ConfigFileState; config: Config }>;
  ensureValidToken: () => Promise<{ token: string; authType: "oauth" | "token" }>;
  getTools: (token: string, authType: "oauth" | "token", forceRefresh: boolean) => Promise<ToolDef[]>;
  phase: <T>(phase: string, operation: () => Promise<T> | T) => Promise<T>;
}

export interface DoctorOptions {
  includeNetwork?: boolean;
  forceRefresh?: boolean;
  deps?: Partial<DoctorDeps>;
}

export interface DoctorArtifact {
  artifact: "readwise-cli-doctor";
  generated_at: string;
  run_id: string;
  summary: {
    status: OverallStatus;
    message: string;
  };
  cli: {
    version: string;
    node_version: string;
    platform: string;
    arch: string;
    debug_enabled: boolean;
  };
  config_file: ConfigFileState;
  config: {
    readonly: unknown;
  };
  auth: AuthState;
  tools_cache: ToolsCacheState;
  checks: Check[];
}

function displayPath(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  if (path.startsWith(`${home}${sep}`)) return `~${path.slice(home.length)}`;
  return path;
}

function isoFromMillis(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return new Date(value).toISOString();
}

function summarizeAuth(config: Config, now: number): AuthState {
  const hasAccessToken = Boolean(config.access_token);
  const authType = config.auth_type === "token" || config.auth_type === "oauth" ? config.auth_type : "oauth";
  const expiresAt = isoFromMillis(config.expires_at);
  const expiresInMs = typeof config.expires_at === "number" ? config.expires_at - now : undefined;

  return {
    status: hasAccessToken ? authType : "not_logged_in",
    has_access_token: hasAccessToken,
    has_refresh_token: Boolean(config.refresh_token),
    has_client_credentials: Boolean(config.client_id && config.client_secret),
    ...(expiresAt ? { expires_at: expiresAt } : {}),
    ...(expiresInMs !== undefined ? {
      expired: expiresInMs <= 0,
      expires_within_60s: expiresInMs <= 60_000,
    } : {}),
  };
}

function summarizeToolsCache(config: Config, now: number): ToolsCacheState {
  const cache = config.tools_cache;
  if (!cache) {
    return {
      present: false,
      valid: false,
      expected_version: TOOLS_CACHE_VERSION,
    };
  }

  const fetchedAt = isoFromMillis(cache.fetched_at);
  const tools = Array.isArray(cache.tools) ? cache.tools : [];

  return {
    present: true,
    valid: isCacheValid(config),
    version: cache.version,
    expected_version: TOOLS_CACHE_VERSION,
    ...(fetchedAt ? { fetched_at: fetchedAt } : {}),
    age_ms: Math.max(0, now - cache.fetched_at),
    tool_count: tools.length,
    read_only_tool_count: tools.filter((tool) => tool.annotations?.readOnlyHint === true).length,
    annotated_tool_count: tools.filter((tool) => tool.annotations !== undefined).length,
  };
}

function knownSecretValues(config: Config): string[] {
  return [
    config.access_token,
    config.refresh_token,
    config.client_secret,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}

function redactKnownSecretText(value: string, secrets: string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

function redactKnownSecrets<T>(value: T, secrets: string[]): T {
  if (secrets.length === 0) return value;
  if (typeof value === "string") return redactKnownSecretText(value, secrets) as T;
  if (Array.isArray(value)) {
    return value.map((item) => redactKnownSecrets(item, secrets)) as T;
  }
  if (typeof value === "object" && value !== null) {
    const redacted: Record<string, unknown> = {};
    for (const [key, childValue] of Object.entries(value)) {
      redacted[key] = redactKnownSecrets(childValue, secrets);
    }
    return redacted as T;
  }
  return value;
}

async function readDefaultConfigFile(): Promise<{ state: ConfigFileState; config: Config }> {
  const path = getConfigPath();

  try {
    const raw = await readFile(path, "utf-8");
    try {
      const parsed = JSON.parse(raw) as unknown;
      const config = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? parsed as Config
        : {};

      return {
        state: {
          path: displayPath(path),
          exists: true,
          readable: true,
          valid_json: true,
        },
        config,
      };
    } catch (error) {
      return {
        state: {
          path: displayPath(path),
          exists: true,
          readable: true,
          valid_json: false,
          error: sanitizeError(error),
        },
        config: {},
      };
    }
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
    const missing = code === "ENOENT";

    return {
      state: {
        path: displayPath(path),
        exists: !missing,
        readable: false,
        valid_json: false,
        ...(missing ? {} : { error: sanitizeError(error) }),
      },
      config: {},
    };
  }
}

function makeCheck(name: string, status: CheckStatus, message: string, extra: Partial<Check> = {}): Check {
  return { name, status, message, ...extra };
}

async function runTimedCheck<T>(
  name: string,
  operation: () => Promise<T>,
  deps: DoctorDeps,
): Promise<{ ok: true; value: T; durationMs: number } | { ok: false; error: unknown; durationMs: number }> {
  const startedAt = deps.now();
  try {
    const value = await deps.phase(`doctor.${name}`, operation);
    return { ok: true, value, durationMs: Math.round(Math.max(0, deps.now() - startedAt)) };
  } catch (error) {
    return { ok: false, error, durationMs: Math.round(Math.max(0, deps.now() - startedAt)) };
  }
}

function summarizeStatus(checks: Check[]): DoctorArtifact["summary"] {
  if (checks.some((check) => check.status === "error")) {
    return {
      status: "error",
      message: "One or more checks failed. Share this artifact with Readwise support.",
    };
  }
  if (checks.some((check) => check.status === "warning" || check.status === "skipped")) {
    return {
      status: "warning",
      message: "Doctor completed with warnings. The artifact is safe to share with Readwise support.",
    };
  }
  return {
    status: "ok",
    message: "Doctor completed successfully. The artifact is safe to share with Readwise support.",
  };
}

export async function collectDoctorArtifact(options: DoctorOptions = {}): Promise<DoctorArtifact> {
  const includeNetwork = options.includeNetwork ?? true;
  const forceRefresh = options.forceRefresh ?? true;
  const deps: DoctorDeps = {
    now: () => Date.now(),
    readConfigFile: readDefaultConfigFile,
    ensureValidToken,
    getTools,
    phase: (phase, operation) => diagnostics.phase(phase, operation),
    ...options.deps,
  };

  const generatedAtMs = deps.now();
  const { state: configFile, config } = await deps.phase("doctor.config", () => deps.readConfigFile());
  const secrets = knownSecretValues(config);
  const checks: Check[] = [];

  if (!configFile.exists) {
    checks.push(makeCheck("config_file", "warning", "No config file found. Run `readwise login` or `readwise login-with-token` to authenticate."));
  } else if (!configFile.readable) {
    checks.push(makeCheck("config_file", "error", "Config file exists but could not be read.", { error: configFile.error }));
  } else if (!configFile.valid_json) {
    checks.push(makeCheck("config_file", "error", "Config file is not valid JSON.", { error: configFile.error }));
  } else {
    checks.push(makeCheck("config_file", "ok", "Config file is readable."));
  }

  const auth = summarizeAuth(config, generatedAtMs);
  const toolsCache = summarizeToolsCache(config, generatedAtMs);

  if (!auth.has_access_token) {
    checks.push(makeCheck("auth", "warning", "No access token is configured."));
    checks.push(makeCheck("mcp_list_tools", "skipped", "MCP check skipped because auth is not configured."));
  } else {
    const authCheck = await runTimedCheck("auth", () => deps.ensureValidToken(), deps);
    if (authCheck.ok) {
      checks.push(makeCheck("auth", "ok", `Authenticated with ${authCheck.value.authType}.`, { duration_ms: authCheck.durationMs }));

      if (includeNetwork) {
        const toolsCheck = await runTimedCheck(
          "mcp_list_tools",
          () => deps.getTools(authCheck.value.token, authCheck.value.authType, forceRefresh),
          deps,
        );
        if (toolsCheck.ok) {
          checks.push(makeCheck("mcp_list_tools", "ok", `Fetched ${toolsCheck.value.length} MCP tools.`, { duration_ms: toolsCheck.durationMs }));
        } else {
          checks.push(makeCheck("mcp_list_tools", "error", "Could not fetch MCP tools.", {
            duration_ms: toolsCheck.durationMs,
            error: sanitizeError(toolsCheck.error),
          }));
        }
      } else {
        checks.push(makeCheck("mcp_list_tools", "skipped", "Network checks were skipped."));
      }
    } else {
      checks.push(makeCheck("auth", "error", "Configured credentials could not be validated.", {
        duration_ms: authCheck.durationMs,
        error: sanitizeError(authCheck.error),
      }));
      checks.push(makeCheck("mcp_list_tools", "skipped", "MCP check skipped because auth validation failed."));
    }
  }

  if (!toolsCache.present) {
    checks.push(makeCheck("tools_cache", "warning", "No cached tool list found."));
  } else if (!toolsCache.valid) {
    checks.push(makeCheck("tools_cache", "warning", "Cached tool list is stale or from an older cache version."));
  } else {
    checks.push(makeCheck("tools_cache", "ok", "Cached tool list is valid."));
  }

  const artifact: DoctorArtifact = {
    artifact: "readwise-cli-doctor",
    generated_at: new Date(generatedAtMs).toISOString(),
    run_id: diagnostics.runId,
    summary: summarizeStatus(checks),
    cli: {
      version: VERSION,
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
      debug_enabled: diagnostics.enabled,
    },
    config_file: configFile,
    config: {
      readonly: getConfigValue(config, "readonly"),
    },
    auth,
    tools_cache: toolsCache,
    checks,
  };

  diagnostics.log("doctor_complete", {
    status: artifact.summary.status,
    checks: checks.map((check) => ({ name: check.name, status: check.status })),
  });

  return redactKnownSecrets(artifact, secrets);
}

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Generate a sanitized support artifact")
    .option("--no-network", "Skip authenticated network checks")
    .action(async (options: { network?: boolean }) => {
      try {
        const artifact = await collectDoctorArtifact({
          includeNetwork: options.network !== false,
          forceRefresh: true,
        });
        console.log(JSON.stringify(artifact, null, 2));
        if (artifact.summary.status === "error") {
          process.exitCode = 1;
        }
      } catch (error) {
        diagnostics.error("doctor", error);
        process.stderr.write(`\x1b[31mFailed to generate doctor artifact: ${(error as Error).message}\x1b[0m\n`);
        process.exitCode = 1;
      }
    });
}
