import assert from "node:assert/strict";
import test from "node:test";
import { createMcpFetch } from "../src/mcp.js";

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
