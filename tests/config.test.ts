import assert from "node:assert/strict";
import test from "node:test";
import {
  filterReadOnlyTools,
  getAllConfigEntries,
  getConfigDefault,
  getConfigValue,
  isCacheValid,
  setConfigValue,
  TOOLS_CACHE_VERSION,
  type Config,
  type ToolDef,
} from "../src/config.js";

test("config values fall back to known defaults", () => {
  assert.equal(getConfigDefault("readonly"), false);
  assert.equal(getConfigValue({}, "readonly"), false);
  assert.deepEqual(getAllConfigEntries({}), { readonly: false });
});

test("setConfigValue parses booleans and stores them under config", () => {
  const config: Config = {};

  setConfigValue(config, "readonly", "true");
  assert.deepEqual(config.config, { readonly: true });

  setConfigValue(config, "readonly", "false");
  assert.deepEqual(config.config, { readonly: false });
});

test("setConfigValue rejects unknown keys and invalid boolean values", () => {
  assert.throws(
    () => setConfigValue({}, "missing", "true"),
    /Unknown config key: "missing"/,
  );
  assert.throws(
    () => setConfigValue({}, "readonly", "yes"),
    /expected "true" or "false"/,
  );
});

test("isCacheValid requires a matching cache version and fresh timestamp", () => {
  const freshConfig: Config = {
    tools_cache: {
      tools: [],
      fetched_at: Date.now(),
      version: TOOLS_CACHE_VERSION,
    },
  };
  const staleConfig: Config = {
    tools_cache: {
      tools: [],
      fetched_at: Date.now() - 25 * 60 * 60 * 1000,
      version: TOOLS_CACHE_VERSION,
    },
  };
  const oldVersionConfig: Config = {
    tools_cache: {
      tools: [],
      fetched_at: Date.now(),
      version: TOOLS_CACHE_VERSION - 1,
    },
  };

  assert.equal(isCacheValid(freshConfig), true);
  assert.equal(isCacheValid(staleConfig), false);
  assert.equal(isCacheValid(oldVersionConfig), false);
  assert.equal(isCacheValid({}), false);
});

test("filterReadOnlyTools keeps only tools explicitly annotated read-only", () => {
  const tools: ToolDef[] = [
    {
      name: "reader_search",
      annotations: { readOnlyHint: true },
      inputSchema: { type: "object" },
    },
    {
      name: "reader_move",
      annotations: { readOnlyHint: false },
      inputSchema: { type: "object" },
    },
    {
      name: "reader_tag",
      inputSchema: { type: "object" },
    },
  ];

  assert.deepEqual(filterReadOnlyTools(tools).map((tool) => tool.name), ["reader_search"]);
});
