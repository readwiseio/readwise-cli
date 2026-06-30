#!/usr/bin/env node
import { createInterface } from "node:readline";
import { Command } from "commander";
import { login, loginWithToken, ensureValidToken, logout } from "./auth.js";
import { getTools } from "./mcp.js";
import { registerTools, toolNameToCommand } from "./commands.js";
import { loadConfig, saveConfig, getConfigValue, setConfigValue, getAllConfigEntries, filterReadOnlyTools } from "./config.js";
import { diagnostics } from "./diagnostics.js";
import { registerDoctorCommand } from "./doctor.js";
import { VERSION } from "./version.js";
import { registerSkillsCommands } from "./skills.js";

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
const STATIC_COMMANDS = new Set(["login", "login-with-token", "config", "skills", "doctor"]);

program
  .name("readwise")
  .version(VERSION)
  .description("Command-line interface for Readwise and Reader")
  .option("--debug", "Print sanitized diagnostic timings to stderr")
  .option("--json", "Output raw JSON (machine-readable)")
  .option("--refresh", "Force-refresh the tool cache");

program
  .command("login")
  .description("Authenticate with Readwise via OAuth (opens browser)")
  .action(async () => {
    try {
      await login();
    } catch (err) {
      diagnostics.error("login", err);
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
      diagnostics.error("login-with-token", err);
      process.stderr.write(`\x1b[31m${(err as Error).message}\x1b[0m\n`);
      process.exitCode = 1;
    }
  });

const configCmd = program
  .command("config")
  .description("Manage CLI configuration");

configCmd
  .command("show")
  .description("Show all configuration values")
  .action(async () => {
    const config = await loadConfig();
    const entries = getAllConfigEntries(config);
    for (const [key, value] of Object.entries(entries)) {
      console.log(`${key} = ${value}`);
    }
  });

configCmd
  .command("get <key>")
  .description("Get a configuration value")
  .action(async (key: string) => {
    const config = await loadConfig();
    console.log(getConfigValue(config, key));
  });

configCmd
  .command("set <key> <value>")
  .description("Set a configuration value")
  .action(async (key: string, value: string) => {
    try {
      const config = await loadConfig();
      const wasReadonly = key === "readonly" && config.config?.readonly === true;

      // Warn before disabling readonly: user will be de-authenticated.
      if (wasReadonly && value === "false") {
        if (!process.stdin.isTTY) {
          process.stderr.write("\x1b[31mCannot disable readonly in non-interactive mode (requires confirmation).\x1b[0m\n");
          process.exitCode = 1;
          return;
        }
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => {
          rl.question("\x1b[33mDisabling readonly mode will log you out and require re-authentication. Continue? [y/N] \x1b[0m", resolve);
        });
        rl.close();
        if (answer.trim().toLowerCase() !== "y") {
          console.log("Aborted.");
          return;
        }
      }

      setConfigValue(config, key, value);
      await saveConfig(config);
      console.log(`${key} = ${getConfigValue(config, key)}`);

      // Disabling readonly via CLI invalidates auth to prevent agents from
      // toggling it off and immediately using write tools.
      if (wasReadonly && value === "false") {
        await logout();
        console.log("Readonly mode disabled. You have been logged out — run `readwise login` to re-authenticate.");
      }
    } catch (err) {
      process.stderr.write(`\x1b[31m${(err as Error).message}\x1b[0m\n`);
      process.exitCode = 1;
    }
  });

registerDoctorCommand(program);

async function main() {
  diagnostics.start();

  const config = await diagnostics.phase("config.load", () => loadConfig());
  const forceRefresh = process.argv.includes("--refresh");
  const positionalArgs = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const hasSubcommand = positionalArgs.length > 0;
  const subcommand = positionalArgs[0];
  const wantsHelp = process.argv.includes("--help") || process.argv.includes("-h");
  const wantsVersion = process.argv.includes("--version") || process.argv.includes("-V");

  // `--version`/`-V` must never touch the network. Let Commander print the
  // version and exit, instead of falling into the TUI/tool-discovery path below
  // (which would hang if MCP is unreachable).
  if (wantsVersion) {
    await program.parseAsync(process.argv);
    return;
  }

  // If no subcommand, TTY, and authenticated → launch TUI (unless --help)
  if (!hasSubcommand && !wantsHelp && process.stdout.isTTY && config.access_token) {
    try {
      const { token, authType } = await ensureValidToken();
      const allTools = await getTools(token, authType, forceRefresh);
      let tools = allTools;
      if (config.config?.readonly) {
        const filtered = filterReadOnlyTools(allTools);
        if (filtered.length === 0 && allTools.length > 0) {
          process.stderr.write("\x1b[33mReadonly mode is on but no tools have annotations. Run `readwise --refresh` to update the cache.\x1b[0m\n");
        }
        tools = filtered;
      }
      const { startTui } = await import("./tui/index.js");
      await startTui(tools, allTools, token, authType);
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

  // Register skills commands (works without auth)
  registerSkillsCommands(program);

  // If not authenticated and trying a non-login command, tell user to log in
  if (!config.access_token && hasSubcommand && !STATIC_COMMANDS.has(subcommand!)) {
    diagnostics.error("auth.required", new Error("Not logged in."), { command: subcommand });
    process.stderr.write("\x1b[31mNot logged in.\x1b[0m Run `readwise login` or `readwise login-with-token` to authenticate.\n");
    process.exitCode = 1;
    return;
  }

  // Try to load tools if we have a token (for subcommand mode)
  if (config.access_token && !STATIC_COMMANDS.has(subcommand ?? "")) {
    try {
      const { token, authType } = await ensureValidToken();
      let tools = await getTools(token, authType, forceRefresh);
      if (config.config?.readonly) {
        const filtered = filterReadOnlyTools(tools);
        if (filtered.length === 0 && tools.length > 0) {
          process.stderr.write("\x1b[33mReadonly mode is on but no tools have annotations. Run `readwise --refresh` to update the cache.\x1b[0m\n");
        }
        // Check if user is trying to run a tool that was filtered out
        if (hasSubcommand) {
          const blockedTool = tools.find(
            (t) => !filtered.includes(t) && toolNameToCommand(t.name) === positionalArgs[0]
          );
          if (blockedTool) {
            process.stderr.write(
              `\x1b[31mCommand "${positionalArgs[0]}" is not available in readonly mode.\x1b[0m Run \`readwise config set readonly false\` to disable readonly mode.\n`
            );
            process.exitCode = 1;
            return;
          }
        }
        tools = filtered;
      }
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
