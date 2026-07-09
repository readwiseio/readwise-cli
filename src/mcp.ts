import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig, saveConfig, isCacheValid, TOOLS_CACHE_VERSION, type SchemaProperty, type ToolDef } from "./config.js";
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

const CREATE_DOCUMENT_LANGUAGE_PROPERTY: SchemaProperty = {
  anyOf: [{ type: "string", maxLength: 30 }, { type: "null" }],
  default: null,
  description: "Language code for the document. When omitted, Reader will auto-detect it.",
  examples: ["de", "en-US"],
};

const BULK_EDIT_LANGUAGE_PROPERTY: SchemaProperty = {
  anyOf: [{ type: "string", maxLength: 30 }, { type: "null" }],
  default: null,
  description: "The new language code for the document",
  examples: ["de", "en-US"],
};

function insertPropertyAfter(
  properties: Record<string, SchemaProperty>,
  afterName: string,
  name: string,
  prop: SchemaProperty,
): Record<string, SchemaProperty> {
  if (properties[name]) return properties;

  const next: Record<string, SchemaProperty> = {};
  let inserted = false;
  for (const [key, value] of Object.entries(properties)) {
    next[key] = value;
    if (key === afterName) {
      next[name] = prop;
      inserted = true;
    }
  }
  if (!inserted) next[name] = prop;
  return next;
}

function addCreateDocumentLanguageSchema(tool: ToolDef): ToolDef {
  const properties = tool.inputSchema.properties;
  if (!properties || properties.language) return tool;

  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: insertPropertyAfter(properties, "summary", "language", CREATE_DOCUMENT_LANGUAGE_PROPERTY),
    },
  };
}

function addBulkEditLanguageSchema(tool: ToolDef): ToolDef {
  const defs = tool.inputSchema.$defs;
  const item = defs?.BulkEditDocumentMetadataItem;
  const properties = item?.properties;
  if (!defs || !item || !properties || properties.language) return tool;

  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      $defs: {
        ...defs,
        BulkEditDocumentMetadataItem: {
          ...item,
          properties: insertPropertyAfter(properties, "summary", "language", BULK_EDIT_LANGUAGE_PROPERTY),
        },
      },
    },
  };
}

export function applyKnownToolSchemaUpdates(tools: ToolDef[]): ToolDef[] {
  // Keep dynamic CLI/TUI forms aligned with backend capabilities that may ship
  // before every production MCP listTools response includes the updated schema.
  return tools.map((tool) => {
    if (tool.name === "reader_create_document") {
      return addCreateDocumentLanguageSchema(tool);
    }
    if (tool.name === "reader_bulk_edit_document_metadata") {
      return addBulkEditLanguageSchema(tool);
    }
    return tool;
  });
}

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
      return applyKnownToolSchemaUpdates(config.tools_cache!.tools);
    }
  }

  const client = new Client({ name: "readwise", version: VERSION });
  const transport = createTransport(token, authType);

  try {
    await client.connect(transport, { timeout: MCP_TIMEOUT_MS });
    const result = await client.listTools({}, { timeout: MCP_TIMEOUT_MS });

    const tools = applyKnownToolSchemaUpdates(result.tools as ToolDef[]);

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
