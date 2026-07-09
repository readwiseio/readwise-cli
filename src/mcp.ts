import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig, saveConfig, isCacheValid, TOOLS_CACHE_VERSION, type ToolDef } from "./config.js";
import { addReaderLanguageSchemas } from "./readerLanguageSchema.js";
import { VERSION } from "./version.js";

const MCP_URL = "https://mcp2.readwise.io/mcp";

// Bound every MCP round-trip so a stalled connection (flaky DNS/IPv6, a proxy,
// a half-open Cloudflare socket) surfaces as an error instead of hanging the
// CLI forever with no output. Without this the SDK's connect()/listTools()/
// callTool() can wait indefinitely if the server accepts the socket but never
// replies.
const MCP_TIMEOUT_MS = 30_000;

export function createMcpFetch(baseFetch: typeof fetch = fetch): typeof fetch {
  return (url, init) => {
    const method = (init?.method ?? (url instanceof Request ? url.method : "GET")).toUpperCase();
    if (method === "GET") {
      // The CLI never consumes server-initiated MCP messages; opting out avoids
      // Node 26/undici stalls when the SDK keeps this optional SSE stream open.
      return Promise.resolve(new Response(null, { status: 405, statusText: "Method Not Allowed" }));
    }
    return baseFetch(url, init);
  };
}

export const mcpFetch = createMcpFetch();

function createTransport(token: string, authType: "oauth" | "token"): StreamableHTTPClientTransport {
  const authHeader = authType === "token" ? `Token ${token}` : `Bearer ${token}`;
  return new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: {
      headers: {
        Authorization: authHeader,
      },
    },
    fetch: mcpFetch,
  });
}

export async function getTools(token: string, authType: "oauth" | "token", forceRefresh = false): Promise<ToolDef[]> {
  if (!forceRefresh) {
    const config = await loadConfig();
    if (isCacheValid(config)) {
      return addReaderLanguageSchemas(config.tools_cache!.tools);
    }
  }

  const client = new Client({ name: "readwise", version: VERSION });
  const transport = createTransport(token, authType);

  try {
    await client.connect(transport, { timeout: MCP_TIMEOUT_MS });
    const result = await client.listTools({}, { timeout: MCP_TIMEOUT_MS });

    const tools = addReaderLanguageSchemas(result.tools as ToolDef[]);

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
    await client.close();
  }
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
  } finally {
    await client.close();
  }
}
