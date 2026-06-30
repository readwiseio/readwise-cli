import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig, saveConfig, isCacheValid, TOOLS_CACHE_VERSION, type ToolDef } from "./config.js";
import { diagnostics } from "./diagnostics.js";
import { VERSION } from "./version.js";

const MCP_URL = "https://mcp2.readwise.io/mcp";

// Bound every MCP round-trip so a stalled connection (flaky DNS/IPv6, a proxy,
// a half-open Cloudflare socket) surfaces as an error instead of hanging the
// CLI forever with no output. Without this the SDK's connect()/listTools()/
// callTool() can wait indefinitely if the server accepts the socket but never
// replies.
const MCP_TIMEOUT_MS = 30_000;

function createTransport(token: string, authType: "oauth" | "token"): StreamableHTTPClientTransport {
  const authHeader = authType === "token" ? `Token ${token}` : `Bearer ${token}`;
  return new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: {
      headers: {
        Authorization: authHeader,
      },
    },
  });
}

export async function getTools(token: string, authType: "oauth" | "token", forceRefresh = false): Promise<ToolDef[]> {
  return await diagnostics.phase("getTools", async () => {
    if (!forceRefresh) {
      const config = await loadConfig();
      if (isCacheValid(config)) {
        diagnostics.log("tools_cache_hit", { tool_count: config.tools_cache!.tools.length });
        return config.tools_cache!.tools;
      }
    }

    const client = new Client({ name: "readwise", version: VERSION });
    const transport = createTransport(token, authType);

    try {
      await diagnostics.phase("mcp.connect", () => client.connect(transport, { timeout: MCP_TIMEOUT_MS }));
      const result = await diagnostics.phase("mcp.listTools", () => client.listTools({}, { timeout: MCP_TIMEOUT_MS }));

      const tools = result.tools as ToolDef[];

      // Cache
      const config = await loadConfig();
      config.tools_cache = {
        tools,
        fetched_at: Date.now(),
        version: TOOLS_CACHE_VERSION,
      };
      await saveConfig(config);

      return tools;
    } finally {
      await diagnostics.phase("client.close", () => client.close());
    }
  });
}

export async function callTool(
  token: string,
  authType: "oauth" | "token",
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean }> {
  return await diagnostics.phase("callTool", async () => {
    const client = new Client({ name: "readwise", version: VERSION });
    const transport = createTransport(token, authType);

    try {
      await diagnostics.phase("mcp.connect", () => client.connect(transport, { timeout: MCP_TIMEOUT_MS }), { tool: name });
      const result = await diagnostics.phase(
        "mcp.callTool",
        () => client.callTool({ name, arguments: args }, undefined, { timeout: MCP_TIMEOUT_MS }),
        { tool: name },
      );
      return result as { content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
    } finally {
      await diagnostics.phase("client.close", () => client.close(), { tool: name });
    }
  }, { tool: name });
}
