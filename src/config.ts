import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDef {
  name: string;
  description?: string;
  annotations?: ToolAnnotations;
  inputSchema: {
    type: string;
    properties?: Record<string, SchemaProperty>;
    required?: string[];
    $defs?: Record<string, SchemaProperty>;
  };
}

export interface SchemaProperty {
  type?: string;
  format?: string;
  description?: string;
  enum?: string[];
  maxLength?: number;
  items?: SchemaProperty;
  default?: unknown;
  examples?: unknown[];
  anyOf?: SchemaProperty[];
  $ref?: string;
  properties?: Record<string, SchemaProperty>;
  required?: string[];
}

export interface CLIConfig {
  readonly?: boolean;
}

const KNOWN_CONFIG_KEYS: Record<string, "boolean"> = {
  readonly: "boolean",
};

export interface Config {
  client_id?: string;
  client_secret?: string;
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  auth_type?: "oauth" | "token";
  tools_cache?: {
    tools: ToolDef[];
    fetched_at: number;
    version?: number;
  };
  config?: CLIConfig;
}

export const TOOLS_CACHE_VERSION = 3;

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function getConfigPath(): string {
  return join(homedir(), ".readwise-cli.json");
}

export async function loadConfig(): Promise<Config> {
  try {
    const data = await readFile(getConfigPath(), "utf-8");
    return JSON.parse(data) as Config;
  } catch {
    return {};
  }
}

export async function saveConfig(config: Config): Promise<void> {
  await writeFile(getConfigPath(), JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function isCacheValid(config: Config): boolean {
  if (!config.tools_cache) return false;
  if (config.tools_cache.version !== TOOLS_CACHE_VERSION) return false;
  return Date.now() - config.tools_cache.fetched_at < CACHE_TTL_MS;
}

export function getConfigValue(config: Config, key: string): unknown {
  const cfg = config.config ?? {};
  return (cfg as Record<string, unknown>)[key] ?? getConfigDefault(key);
}

export function getConfigDefault(key: string): unknown {
  switch (key) {
    case "readonly": return false;
    default: return undefined;
  }
}

export function getAllConfigEntries(config: Config): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  for (const key of Object.keys(KNOWN_CONFIG_KEYS)) {
    entries[key] = getConfigValue(config, key);
  }
  return entries;
}

export function setConfigValue(config: Config, key: string, rawValue: string): void {
  const type = KNOWN_CONFIG_KEYS[key];
  if (!type) {
    throw new Error(`Unknown config key: "${key}". Known keys: ${Object.keys(KNOWN_CONFIG_KEYS).join(", ")}`);
  }

  let parsed: unknown;
  if (type === "boolean") {
    if (rawValue === "true") parsed = true;
    else if (rawValue === "false") parsed = false;
    else throw new Error(`Invalid value for "${key}": expected "true" or "false"`);
  }

  if (!config.config) config.config = {};
  (config.config as Record<string, unknown>)[key] = parsed;
}

export function filterReadOnlyTools(tools: ToolDef[]): ToolDef[] {
  return tools.filter((t) => t.annotations?.readOnlyHint === true);
}
