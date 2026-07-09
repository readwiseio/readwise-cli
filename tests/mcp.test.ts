import assert from "node:assert/strict";
import test from "node:test";
import { applyKnownToolSchemaUpdates, createMcpFetch } from "../src/mcp.js";
import type { ToolDef } from "../src/config.js";

test("mcp fetch opts out of the optional GET SSE stream", async () => {
  let delegated = false;
  const wrappedFetch = createMcpFetch(async () => {
    delegated = true;
    return new Response(null, { status: 500 });
  });

  const response = await wrappedFetch("https://mcp2.readwise.io/mcp", { method: "GET" });

  assert.equal(response.status, 405);
  assert.equal(response.statusText, "Method Not Allowed");
  assert.equal(delegated, false);
});

test("mcp fetch delegates non-GET requests", async () => {
  let seenUrl = "";
  let seenMethod = "";
  const wrappedFetch = createMcpFetch(async (url, init) => {
    seenUrl = String(url);
    seenMethod = init?.method ?? "";
    return new Response("{}", { status: 200 });
  });

  const response = await wrappedFetch("https://mcp2.readwise.io/mcp", { method: "POST", body: "{}" });

  assert.equal(response.status, 200);
  assert.equal(seenUrl, "https://mcp2.readwise.io/mcp");
  assert.equal(seenMethod, "POST");
});

test("mcp fetch reads the method from Request inputs", async () => {
  let delegated = false;
  const wrappedFetch = createMcpFetch(async () => {
    delegated = true;
    return new Response("{}", { status: 200 });
  });

  const response = await wrappedFetch(new Request("https://mcp2.readwise.io/mcp", { method: "POST" }));

  assert.equal(response.status, 200);
  assert.equal(delegated, true);
});

test("known schema updates add Reader create language support when missing", () => {
  const tools: ToolDef[] = [{
    name: "reader_create_document",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        summary: { anyOf: [{ type: "string" }, { type: "null" }], default: null },
        title: { anyOf: [{ type: "string" }, { type: "null" }], default: null },
      },
    },
  }];

  const [tool] = applyKnownToolSchemaUpdates(tools);
  const properties = tool!.inputSchema.properties!;

  assert.deepEqual(Object.keys(properties), ["url", "summary", "language", "title"]);
  assert.equal(properties.language?.description, "Language code for the document. When omitted, Reader will auto-detect it.");
  assert.equal(properties.language?.anyOf?.[0]?.maxLength, 30);
});

test("known schema updates add Reader bulk edit language support when missing", () => {
  const tools: ToolDef[] = [{
    name: "reader_bulk_edit_document_metadata",
    inputSchema: {
      type: "object",
      properties: {
        documents: {
          type: "array",
          items: { $ref: "#/$defs/BulkEditDocumentMetadataItem" },
        },
      },
      $defs: {
        BulkEditDocumentMetadataItem: {
          type: "object",
          properties: {
            document_id: { type: "string" },
            summary: { anyOf: [{ type: "string" }, { type: "null" }], default: null },
            seen: { anyOf: [{ type: "boolean" }, { type: "null" }], default: null },
          },
          required: ["document_id"],
        },
      },
    },
  }];

  const [tool] = applyKnownToolSchemaUpdates(tools);
  const properties = tool!.inputSchema.$defs!.BulkEditDocumentMetadataItem!.properties!;

  assert.deepEqual(Object.keys(properties), ["document_id", "summary", "language", "seen"]);
  assert.equal(properties.language?.description, "The new language code for the document");
  assert.equal(properties.language?.anyOf?.[0]?.maxLength, 30);
});
