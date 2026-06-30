import test from "node:test";
import assert from "node:assert/strict";
import { createDiagnostics, isDebugRequested, sanitizeError } from "../src/diagnostics.js";

function parseDebugLines(lines: string[]): Array<Record<string, unknown>> {
  return lines.map((line) => {
    assert.equal(line.startsWith("[readwise-cli debug] "), true);
    return JSON.parse(line.replace("[readwise-cli debug] ", ""));
  });
}

test("debug mode can be enabled with --debug or READWISE_CLI_DEBUG", () => {
  assert.equal(isDebugRequested(["node", "readwise"], {}), false);
  assert.equal(isDebugRequested(["node", "readwise", "--debug"], {}), true);
  assert.equal(isDebugRequested(["node", "readwise"], { READWISE_CLI_DEBUG: "1" }), true);
  assert.equal(isDebugRequested(["node", "readwise"], { READWISE_CLI_DEBUG: "true" }), true);
  assert.equal(isDebugRequested(["node", "readwise"], { READWISE_CLI_DEBUG: "0" }), false);
});

test("diagnostics emits CLI metadata and phase timing to stderr", async () => {
  const lines: string[] = [];
  let now = 100;
  const diagnostics = createDiagnostics({
    enabled: true,
    runId: "test-run-id",
    cliVersion: "0.5.6",
    nodeVersion: "v22.0.0",
    platform: "darwin",
    arch: "arm64",
    write: (line) => lines.push(line),
    now: () => now,
  });

  diagnostics.start();
  const result = await diagnostics.phase("ensureValidToken", async () => {
    now = 128.43;
    return "ok";
  });

  assert.equal(result, "ok");

  const events = parseDebugLines(lines);
  assert.deepEqual(events[0], {
    event: "cli_start",
    run_id: "test-run-id",
    cli_version: "0.5.6",
    node_version: "v22.0.0",
    platform: "darwin",
    arch: "arm64",
  });
  assert.equal(events[1].event, "phase_start");
  assert.equal(events[1].phase, "ensureValidToken");
  assert.equal(events[1].run_id, "test-run-id");
  assert.equal(events[2].event, "phase_end");
  assert.equal(events[2].phase, "ensureValidToken");
  assert.equal(events[2].duration_ms, 28);
});

test("disabled diagnostics are silent while preserving phase behavior", async () => {
  const lines: string[] = [];
  const diagnostics = createDiagnostics({
    enabled: false,
    runId: "test-run-id",
    cliVersion: "0.5.6",
    nodeVersion: "v22.0.0",
    platform: "darwin",
    arch: "arm64",
    write: (line) => lines.push(line),
    now: () => 0,
  });

  const result = await diagnostics.phase("mcp.connect", async () => "ok");

  assert.equal(result, "ok");
  assert.deepEqual(lines, []);
});

test("phase errors include sanitized details", async () => {
  const lines: string[] = [];
  let now = 5;
  const diagnostics = createDiagnostics({
    enabled: true,
    runId: "test-run-id",
    cliVersion: "0.5.6",
    nodeVersion: "v22.0.0",
    platform: "darwin",
    arch: "arm64",
    write: (line) => lines.push(line),
    now: () => now,
  });
  const error = Object.assign(
    new Error("Token refresh failed: access_token=abc123&client_secret=shh Authorization: Bearer secret-token"),
    { code: "ERR_BAD_RESPONSE", status: 500 },
  );

  await assert.rejects(
    diagnostics.phase("callTool", async () => {
      now = 9.2;
      throw error;
    }),
    /Token refresh failed/,
  );

  const event = parseDebugLines(lines).at(-1)!;
  const serialized = JSON.stringify(event);

  assert.equal(event.event, "phase_error");
  assert.equal(event.phase, "callTool");
  assert.equal(event.duration_ms, 4);
  assert.equal((event.error as Record<string, unknown>).name, "Error");
  assert.equal((event.error as Record<string, unknown>).code, "ERR_BAD_RESPONSE");
  assert.equal((event.error as Record<string, unknown>).status, 500);
  assert.match((event.error as Record<string, string>).message, /access_token=\[REDACTED\]/);
  assert.match((event.error as Record<string, string>).message, /client_secret=\[REDACTED\]/);
  assert.doesNotMatch(serialized, /abc123|shh|secret-token/);
});

test("sanitizeError handles non-Error throws without leaking token-shaped values", () => {
  const sanitized = sanitizeError({
    message: "failed with refresh_token=refresh-secret",
    token: "raw-token",
    code: "E_TOKEN",
  });

  assert.deepEqual(sanitized, {
    name: "Object",
    message: "failed with refresh_token=[REDACTED]",
    code: "E_TOKEN",
  });
  assert.doesNotMatch(JSON.stringify(sanitized), /refresh-secret|raw-token/);
});
