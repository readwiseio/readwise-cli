import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectDoctorArtifact } from "../src/doctor.js";
import { TOOLS_CACHE_VERSION, type Config } from "../src/config.js";

const FIXED_NOW = Date.parse("2026-06-30T12:00:00.000Z");

test("doctor artifact captures auth failures without leaking configured secrets", async () => {
  const config: Config = {
    access_token: "secret-access-token",
    refresh_token: "secret-refresh-token",
    client_id: "client-id",
    client_secret: "secret-client-secret",
    auth_type: "oauth",
    expires_at: FIXED_NOW - 1_000,
    config: { readonly: true },
    tools_cache: {
      fetched_at: FIXED_NOW - 10_000,
      version: TOOLS_CACHE_VERSION,
      tools: [
        {
          name: "reader_search_documents",
          annotations: { readOnlyHint: true },
          inputSchema: { type: "object" },
        },
      ],
    },
  };

  const artifact = await collectDoctorArtifact({
    deps: {
      now: () => FIXED_NOW,
      readConfigFile: async () => ({
        state: {
          path: "~/.readwise-cli.json",
          exists: true,
          readable: true,
          valid_json: true,
        },
        config,
      }),
      ensureValidToken: async () => {
        throw new Error("Token refresh failed for secret-access-token: refresh_token=secret-refresh-token Authorization: Bearer secret-access-token");
      },
      getTools: async () => {
        throw new Error("should not fetch tools when auth fails");
      },
      phase: async (_phase, operation) => await operation(),
    },
  });

  const serialized = JSON.stringify(artifact);

  assert.equal(artifact.summary.status, "error");
  assert.equal(artifact.auth.status, "oauth");
  assert.equal(artifact.auth.has_access_token, true);
  assert.equal(artifact.auth.has_refresh_token, true);
  assert.equal(artifact.auth.has_client_credentials, true);
  assert.equal(artifact.config.readonly, true);
  assert.equal(artifact.tools_cache.valid, true);
  assert.deepEqual(artifact.checks.map((check) => [check.name, check.status]), [
    ["config_file", "ok"],
    ["auth", "error"],
    ["mcp_list_tools", "skipped"],
    ["tools_cache", "ok"],
  ]);
  assert.match(serialized, /refresh_token=\[REDACTED\]/);
  assert.match(serialized, /Authorization: Bearer \[REDACTED\]/);
  assert.doesNotMatch(serialized, /secret-access-token|secret-refresh-token|secret-client-secret/);
});

test("doctor artifact skips auth and MCP checks when logged out", async () => {
  let ensureCalls = 0;
  let getToolsCalls = 0;

  const artifact = await collectDoctorArtifact({
    deps: {
      now: () => FIXED_NOW,
      readConfigFile: async () => ({
        state: {
          path: "~/.readwise-cli.json",
          exists: false,
          readable: false,
          valid_json: false,
        },
        config: {},
      }),
      ensureValidToken: async () => {
        ensureCalls += 1;
        return { token: "unused", authType: "token" };
      },
      getTools: async () => {
        getToolsCalls += 1;
        return [];
      },
      phase: async (_phase, operation) => await operation(),
    },
  });

  assert.equal(artifact.summary.status, "warning");
  assert.equal(artifact.auth.status, "not_logged_in");
  assert.equal(artifact.tools_cache.present, false);
  assert.equal(ensureCalls, 0);
  assert.equal(getToolsCalls, 0);
  assert.deepEqual(artifact.checks.map((check) => [check.name, check.status]), [
    ["config_file", "warning"],
    ["auth", "warning"],
    ["mcp_list_tools", "skipped"],
    ["tools_cache", "warning"],
  ]);
});

test("readwise doctor runs without auth and prints a support artifact", () => {
  const home = mkdtempSync(join(tmpdir(), "readwise-cli-test-"));

  try {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/index.ts", "doctor", "--no-network"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          READWISE_CLI_DEBUG: undefined,
        },
        encoding: "utf-8",
      },
    );

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.doesNotMatch(result.stdout, /Not logged in/);

    const artifact = JSON.parse(result.stdout) as { artifact?: string; summary?: { status?: string }; auth?: { status?: string } };
    assert.equal(artifact.artifact, "readwise-cli-doctor");
    assert.equal(artifact.summary?.status, "warning");
    assert.equal(artifact.auth?.status, "not_logged_in");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
