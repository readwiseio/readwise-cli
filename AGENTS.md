# Agent Instructions

This file is for coding agents working in this repository. Keep it concrete and update it when commands, file layout, or safety constraints change.

## Project Summary

`@readwise/cli` is a Node/TypeScript command-line interface for Readwise and Reader. It talks to the Readwise MCP server at `https://mcp2.readwise.io/mcp`, discovers MCP tools, and exposes those tools as CLI commands. It also includes a full-screen terminal UI and a `skills` installer for AI-agent workflows from `readwiseio/readwise-skills`.

## Commands

Install dependencies from the lockfile before running local checks:

```bash
npm ci
```

Primary validation commands:

```bash
npm test
npm run build
node dist/index.js --version
node dist/index.js --help
```

Development command:

```bash
npm run dev -- --help
```

Notes:

- CI runs `npm ci`, `npm test`, and `npm run build` on Node.js 22 in `.github/workflows/test.yml`.
- Publishing runs on Node.js 24 with npm 11 in `.github/workflows/publish-npm.yml`.
- There is no lint script in `package.json`.
- `dist/` and `node_modules/` are ignored build/dependency outputs.

## Repository Map

- `src/index.ts` is the CLI entry point. It wires Commander commands, auth, config, tool discovery, readonly filtering, the TUI launch path, and skills commands.
- `src/auth.ts` handles OAuth, token login, token refresh, and logout. OAuth uses `http://localhost:6274/callback`.
- `src/mcp.ts` creates the MCP HTTP transport, lists tools, calls tools, and enforces 30 second MCP timeouts.
- `src/commands.ts` converts MCP tool schemas into Commander options and executes tool calls.
- `src/config.ts` owns `~/.readwise-cli.json`, tool-cache shape, config defaults, readonly parsing, and readonly tool filtering.
- `src/skills.ts` fetches and installs Readwise skills into local Claude, Codex, or OpenCode skill directories. Its cache lives at `~/.readwise/skills-cache`.
- `src/tui/` contains the full-screen terminal UI and low-level ANSI/keyboard helpers.
- `tests/` contains Node test-runner unit tests for pure command/config helpers.

## Behavior To Preserve

- `readwise --version` and unauthenticated help paths must not require network access.
- Keep network operations bounded. Existing OAuth/fetch/MCP paths use 30 second timeouts so the CLI does not hang indefinitely.
- Do not print access tokens, refresh tokens, client secrets, or user-provided token input.
- `login-with-token` must keep supporting hidden TTY input and piped token input.
- The CLI stores credentials and config in `~/.readwise-cli.json`. Tests that touch config files should isolate `HOME` or use pure helper functions.
- Tool discovery is cached for 24 hours in `tools_cache`; bump `TOOLS_CACHE_VERSION` in `src/config.ts` when cached tool shape or filtering assumptions change.
- CLI command names are generated from MCP tool names by replacing `_` with `-`. Preserve that mapping unless coordinating a breaking CLI change.
- Readonly mode only exposes tools with `annotations.readOnlyHint === true`. Disabling readonly through `readwise config set readonly false` requires interactive confirmation and logs the user out so an agent cannot silently re-enable write tools.
- The TUI enters the alternate screen buffer and must always restore terminal state with `exitFullScreen()` in a `finally` path.
- The skills installer writes outside the repo into agent-specific directories under the user's home directory. Be explicit in tests or docs when a command has that side effect.

## Testing Guidance

- Prefer unit tests for schema parsing, command-option conversion, config defaults, cache validity, and readonly filtering.
- Avoid live Readwise/MCP calls in automated tests. Mock boundaries around `fetch`, `Client`, or exported helpers when testing auth, MCP, or skills behavior.
- For CLI smoke checks, build first with `npm run build`, then run `node dist/index.js --version` and `node dist/index.js --help`.
- If changing terminal UI behavior, manually exercise the TUI in a real TTY; basic `npm test` does not cover raw-mode keyboard handling or alternate-screen cleanup.
- `npm audit --omit=dev` currently reports transitive production dependency advisories. Do not run `npm audit fix` as an incidental cleanup; review lockfile and runtime impact deliberately.

## Release Notes

Users only receive changes after a GitHub Release triggers the `Publish npm package` workflow. For release PRs, update both `package.json` and `package-lock.json`. The release tag must be exactly `v<package.json version>`, the version must be stable semver, and the tag must point at a commit on `origin/master`.

