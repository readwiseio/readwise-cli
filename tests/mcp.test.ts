import assert from "node:assert/strict";
import test from "node:test";
import { mcpRequestHeaders, RUN_ID, userAgent } from "../src/mcp.js";
import { VERSION } from "../src/version.js";

test("MCP headers include CLI version, run id, correlation id, and user agent", () => {
  const headers = mcpRequestHeaders("Bearer test-token", "run-123");

  assert.equal(headers.Authorization, "Bearer test-token");
  assert.equal(headers["X-Readwise-CLI-Version"], VERSION);
  assert.equal(headers["X-Readwise-CLI-Run-ID"], "run-123");
  assert.equal(headers["X-Correlation-ID"], "run-123");
  assert.equal(headers["User-Agent"], userAgent());
});

test("RUN_ID is generated once for the CLI process", () => {
  assert.match(RUN_ID, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(mcpRequestHeaders("Token test-token")["X-Readwise-CLI-Run-ID"], RUN_ID);
});

test("user agent identifies readwise-cli, Node, platform, and architecture", () => {
  assert.equal(userAgent(), `readwise-cli/${VERSION} node/${process.versions.node} ${process.platform}/${process.arch}`);
});
