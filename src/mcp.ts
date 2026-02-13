import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig, saveConfig, isCacheValid, type ToolDef } from "./config.js";
import { VERSION } from "./version.js";

const MCP_URL = "https://mcp2.readwise.io/mcp";

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
  if (!forceRefresh) {
    const config = await loadConfig();
    if (isCacheValid(config)) {
      return config.tools_cache!.tools;
    }
  }

  const client = new Client({ name: "readwise-cli", version: VERSION });
  const transport = createTransport(token, authType);

  try {
    await client.connect(transport);
    const result = await client.listTools();

    const tools = result.tools as ToolDef[];

    // Cache
    const config = await loadConfig();
    config.tools_cache = {
      tools,
      fetched_at: Date.now(),
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
): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }> {
  const client = new Client({ name: "readwise-cli", version: VERSION });
  const transport = createTransport(token, authType);

  try {
    await client.connect(transport);
    const result = await client.callTool({ name, arguments: args });
    return result as { content: Array<{ type: string; text?: string }>; isError?: boolean };
  } finally {
    await client.close();
  }
}
