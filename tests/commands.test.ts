import assert from "node:assert/strict";
import test from "node:test";
import {
  optionDescription,
  optionFlag,
  parseValue,
  resolveProperty,
  resolveRef,
  toolNameToCommand,
} from "../src/commands.js";
import type { SchemaProperty } from "../src/config.js";

test("toolNameToCommand converts MCP tool names to CLI command names", () => {
  assert.equal(toolNameToCommand("reader_search_documents"), "reader-search-documents");
});

test("optionFlag formats boolean and value options", () => {
  assert.equal(optionFlag("include_archived", { type: "boolean" }), "--include-archived");
  assert.equal(optionFlag("document_id", { type: "string" }), "--document-id <value>");
});

test("optionDescription includes schema constraints for generated help", () => {
  assert.equal(
    optionDescription({ type: "string", description: "Article language", maxLength: 30 }, true),
    "Article language (required) (max length: 30)",
  );
});

test("parseValue handles numbers, booleans, arrays, and strings", () => {
  assert.equal(parseValue("42", { type: "integer" }), 42);
  assert.equal(parseValue("3.14", { type: "number" }), 3.14);
  assert.equal(parseValue("ignored", { type: "boolean" }), true);
  assert.deepEqual(parseValue('["article","pdf"]', { type: "array" }), ["article", "pdf"]);
  assert.deepEqual(parseValue("article, pdf", { type: "array" }), ["article", "pdf"]);
  assert.equal(parseValue("reader", { type: "string" }), "reader");
});

test("parseValue rejects invalid numbers", () => {
  assert.throws(
    () => parseValue("abc", { type: "number" }),
    /Expected a number for value: abc/,
  );
});

test("resolveRef merges referenced schemas with local descriptions", () => {
  const defs: Record<string, SchemaProperty> = {
    DocumentId: { type: "string", description: "Fallback description" },
  };

  assert.deepEqual(resolveRef({ $ref: "#/$defs/DocumentId", description: "Document to update" }, defs), {
    type: "string",
    description: "Document to update",
  });
});

test("resolveProperty unwraps non-null anyOf variants", () => {
  assert.deepEqual(
    resolveProperty({
      anyOf: [{ type: "null" }, { type: "string", enum: ["article", "pdf"] }],
    }),
    { type: "string", enum: ["article", "pdf"], anyOf: undefined },
  );
});

test("resolveProperty resolves referenced array item schemas", () => {
  const defs: Record<string, SchemaProperty> = {
    Category: { type: "string", enum: ["article", "pdf"] },
  };

  const resolved = resolveProperty({ type: "array", items: { $ref: "#/$defs/Category" } }, defs);

  assert.equal(resolved.type, "array");
  assert.equal(resolved.items?.type, "string");
  assert.deepEqual(resolved.items?.enum, ["article", "pdf"]);
});
