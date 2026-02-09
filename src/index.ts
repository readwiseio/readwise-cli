#!/usr/bin/env node
import { Command } from "commander";
import { login, ensureValidToken } from "./auth.js";
import { getTools } from "./mcp.js";
import { registerTools } from "./commands.js";
import { loadConfig } from "./config.js";

const program = new Command();

program
  .name("readwise-cli")
  .version("0.1.0")
  .description("Command-line interface for Readwise and Reader")
  .option("--json", "Output raw JSON (machine-readable)")
  .option("--refresh", "Force-refresh the tool cache");

program
  .command("login")
  .description("Authenticate with Readwise via OAuth")
  .action(async () => {
    try {
      await login();
    } catch (err) {
      process.stderr.write(`\x1b[31m${(err as Error).message}\x1b[0m\n`);
      process.exitCode = 1;
    }
  });

async function main() {
  const config = await loadConfig();
  const forceRefresh = process.argv.includes("--refresh");

  // Try to load tools if we have a token
  if (config.access_token) {
    try {
      const token = await ensureValidToken();
      const tools = await getTools(token, forceRefresh);
      registerTools(program, tools);
    } catch (err) {
      // Don't fail — login command should still work
      // Only warn if user is trying to run a non-login command
      const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
      if (args.length > 0 && args[0] !== "login") {
        process.stderr.write(`\x1b[33mWarning: Could not fetch tools: ${(err as Error).message}\x1b[0m\n`);
      }
    }
  }

  await program.parseAsync(process.argv);
}

main();
