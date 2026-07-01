import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig, saveConfig, isCacheValid, TOOLS_CACHE_VERSION, type ToolDef } from "./config.js";
import { VERSION } from "./version.js";

export const DEFAULT_MCP_URL = "https://mcp2.readwise.io/mcp";

// Bound every MCP round-trip so a stalled connection (flaky DNS/IPv6, a proxy,
// a half-open Cloudflare socket) surfaces as an error instead of hanging the
// CLI forever with no output. Without this the SDK's connect()/listTools()/
// callTool() can wait indefinitely if the server accepts the socket but never
// replies.
const MCP_TIMEOUT_MS = 30_000;
const CLI_RUN_ID = randomUUID();

export function getMcpUrl(): string {
  return process.env.READWISE_MCP_URL || DEFAULT_MCP_URL;
}

export function getCliRunId(): string {
  return CLI_RUN_ID;
}

export function getMcpRequestHeaders(token: string, authType: "oauth" | "token"): Record<string, string> {
  const authHeader = authType === "token" ? `Token ${token}` : `Bearer ${token}`;
  return {
    Authorization: authHeader,
    "X-Readwise-CLI-Version": VERSION,
    "X-Readwise-CLI-Run-ID": CLI_RUN_ID,
    "X-Correlation-ID": CLI_RUN_ID,
    "User-Agent": `readwise-cli/${VERSION} node/${process.versions.node} ${process.platform}/${process.arch}`,
  };
}

export function formatMcpError(phase: string, err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`${phase} failed (readwise_cli_run_id=${CLI_RUN_ID}): ${message}`);
}

function createTransport(token: string, authType: "oauth" | "token"): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(getMcpUrl()), {
    requestInit: {
      headers: getMcpRequestHeaders(token, authType),
    },
  });
}

export async function getTools(token: string, authType: "oauth" | "token", forceRefresh = false): Promise<ToolDef[]> {
  if (!forceRefresh) {
    const config = await loadConfig();
    if (isCacheValid(config)) {
      return config.tools_cache!.tools;
    }
  }

  const client = new Client({ name: "readwise", version: VERSION });
  const transport = createTransport(token, authType);
  let tools: ToolDef[];

  try {
    await client.connect(transport, { timeout: MCP_TIMEOUT_MS });
    const result = await client.listTools({}, { timeout: MCP_TIMEOUT_MS });
    tools = result.tools as ToolDef[];
  } catch (err) {
    throw formatMcpError("MCP tool discovery", err);
  } finally {
    await client.close();
  }

  // Cache
  const config = await loadConfig();
  config.tools_cache = {
    tools,
    fetched_at: Date.now(),
    version: TOOLS_CACHE_VERSION,
  };
  await saveConfig(config);

  return tools;
}

export async function callTool(
  token: string,
  authType: "oauth" | "token",
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean }> {
  const client = new Client({ name: "readwise", version: VERSION });
  const transport = createTransport(token, authType);

  try {
    await client.connect(transport, { timeout: MCP_TIMEOUT_MS });
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: MCP_TIMEOUT_MS });
    return result as { content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
  } catch (err) {
    throw formatMcpError(`MCP tool call "${name}"`, err);
  } finally {
    await client.close();
  }
}
