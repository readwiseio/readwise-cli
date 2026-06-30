import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("debug output includes sanitized error details for unauthenticated commands", () => {
  const home = mkdtempSync(join(tmpdir(), "readwise-cli-test-"));

  try {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/index.ts", "--debug", "reader-search-documents", "--query", "secret query"],
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

    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[readwise-cli debug\]/);
    assert.match(result.stderr, /"event":"error"/);
    assert.match(result.stderr, /"phase":"auth.required"/);
    assert.match(result.stderr, /"command":"reader-search-documents"/);
    assert.match(result.stderr, /Not logged in/);
    assert.doesNotMatch(result.stderr, /secret query/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
