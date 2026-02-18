import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ToolDef {
  name: string;
  description?: string;
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
  items?: SchemaProperty;
  default?: unknown;
  examples?: unknown[];
  anyOf?: SchemaProperty[];
  $ref?: string;
  properties?: Record<string, SchemaProperty>;
  required?: string[];
}

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
  };
}

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
  return Date.now() - config.tools_cache.fetched_at < CACHE_TTL_MS;
}
