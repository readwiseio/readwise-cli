import assert from "node:assert/strict";
import test from "node:test";
import { formatMcpError, getCliRunId, getMcpRequestHeaders } from "../src/mcp.js";
import { VERSION } from "../src/version.js";

test("MCP request headers include auth and CLI correlation metadata", () => {
  const headers = getMcpRequestHeaders("rw-token", "token");
  const runId = getCliRunId();

  assert.match(runId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(headers.Authorization, "Token rw-token");
  assert.equal(headers["X-Readwise-CLI-Version"], VERSION);
  assert.equal(headers["X-Readwise-CLI-Run-ID"], runId);
  assert.equal(headers["X-Correlation-ID"], runId);
  assert.equal(headers["User-Agent"].startsWith(`readwise-cli/${VERSION} node/`), true);
});

test("MCP request headers use bearer auth for OAuth tokens", () => {
  const headers = getMcpRequestHeaders("oauth-token", "oauth");

  assert.equal(headers.Authorization, "Bearer oauth-token");
});

test("MCP errors include the CLI run id", () => {
  const err = formatMcpError("MCP tool discovery", new Error("Request timed out"));

  assert.match(err.message, /^MCP tool discovery failed/);
  assert.match(err.message, new RegExp(`readwise_cli_run_id=${getCliRunId()}`));
  assert.match(err.message, /Request timed out/);
});
