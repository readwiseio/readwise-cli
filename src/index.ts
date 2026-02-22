#!/usr/bin/env node
import { createInterface } from "node:readline";
import { Command } from "commander";
import { login, loginWithToken, ensureValidToken } from "./auth.js";
import { getTools } from "./mcp.js";
import { registerTools } from "./commands.js";
import { loadConfig } from "./config.js";
import { VERSION } from "./version.js";

function readHiddenInput(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      // Piped input (e.g. echo $TOKEN | readwise login-with-token)
      const rl = createInterface({ input: process.stdin });
      rl.once("line", (line) => { resolve(line.trim()); rl.close(); });
      rl.once("close", () => resolve(""));
      return;
    }

    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");

    let input = "";
    const onData = (ch: string) => {
      if (ch === "\r" || ch === "\n" || ch === "\u0004") {
        process.stdin.removeListener("data", onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write("\n");
        resolve(input);
      } else if (ch === "\u0003") {
        process.stdin.removeListener("data", onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write("\n");
        reject(new Error("Aborted"));
      } else if (ch === "\u007f" || ch === "\b") {
        input = input.slice(0, -1);
      } else {
        input += ch;
      }
    };
    process.stdin.on("data", onData);
  });
}

const program = new Command();

program
  .name("readwise")
  .version(VERSION)
  .description("Command-line interface for Readwise and Reader")
  .option("--json", "Output raw JSON (machine-readable)")
  .option("--refresh", "Force-refresh the tool cache");

program
  .command("login")
  .description("Authenticate with Readwise via OAuth (opens browser)")
  .action(async () => {
    try {
      await login();
    } catch (err) {
      process.stderr.write(`\x1b[31m${(err as Error).message}\x1b[0m\n`);
      process.exitCode = 1;
    }
  });

program
  .command("login-with-token [token]")
  .description("Authenticate with a Readwise access token (for scripts/CI)")
  .action(async (token?: string) => {
    try {
      if (!token) {
        console.log("Get your token from https://readwise.io/access_token");
        token = await readHiddenInput("Enter token: ");
        if (!token) {
          process.stderr.write("\x1b[31mNo token provided.\x1b[0m\n");
          process.exitCode = 1;
          return;
        }
      }
      await loginWithToken(token);
    } catch (err) {
      process.stderr.write(`\x1b[31m${(err as Error).message}\x1b[0m\n`);
      process.exitCode = 1;
    }
  });

async function main() {
  const config = await loadConfig();
  const forceRefresh = process.argv.includes("--refresh");
  const positionalArgs = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const hasSubcommand = positionalArgs.length > 0;
  const wantsHelp = process.argv.includes("--help") || process.argv.includes("-h");

  // If no subcommand, TTY, and authenticated → launch TUI (unless --help)
  if (!hasSubcommand && !wantsHelp && process.stdout.isTTY && config.access_token) {
    try {
      const { token, authType } = await ensureValidToken();
      const tools = await getTools(token, authType, forceRefresh);
      const { startTui } = await import("./tui/index.js");
      await startTui(tools, token, authType);
      return;
    } catch (err) {
      process.stderr.write(`\x1b[33mWarning: Could not start TUI: ${(err as Error).message}\x1b[0m\n`);
      // Fall through to Commander help
    }
  }

  // If no subcommand and not authenticated → hint to login
  if (!hasSubcommand && process.stdout.isTTY && !config.access_token) {
    await program.parseAsync(process.argv);
    console.log("\nRun `readwise login` or `readwise login-with-token` to authenticate.");
    return;
  }

  // If not authenticated and trying a non-login command, tell user to log in
  if (!config.access_token && hasSubcommand && positionalArgs[0] !== "login" && positionalArgs[0] !== "login-with-token") {
    process.stderr.write("\x1b[31mNot logged in.\x1b[0m Run `readwise login` or `readwise login-with-token` to authenticate.\n");
    process.exitCode = 1;
    return;
  }

  // Try to load tools if we have a token (for subcommand mode)
  if (config.access_token) {
    try {
      const { token, authType } = await ensureValidToken();
      const tools = await getTools(token, authType, forceRefresh);
      registerTools(program, tools);
    } catch (err) {
      // Don't fail — login command should still work
      if (hasSubcommand && positionalArgs[0] !== "login" && positionalArgs[0] !== "login-with-token") {
        process.stderr.write(`\x1b[33mWarning: Could not fetch tools: ${(err as Error).message}\x1b[0m\n`);
      }
    }
  }

  await program.parseAsync(process.argv);
}

main();
