---
name: readwise-cli-local-verification
description: Use when verifying Readwise CLI MCP changes against local Docker resources, running the CLI with READWISE_MCP_URL, debugging local mcp2 or rekindled web failures, or confirming end-to-end auth and tool calls without using production MCP.
---

# Readwise CLI Local Verification

## Overview

Use this skill to verify Readwise CLI changes against the local `rekindled` MCP stack. Keep local verification evidence precise: unit/build checks prove the CLI package, while Docker-backed smoke tests prove the CLI can authenticate, discover MCP tools, and call local tools end to end.

## Ground Rules

- Do not print `READWISE_TOKEN`, OAuth tokens, API keys, or full local document payloads.
- Use a temporary `HOME` for auth smoke tests so `~/.readwise-cli.json` is not touched.
- Set `READWISE_MCP_URL=http://localhost:8103/mcp` for local MCP checks.
- Use `--refresh` when proving command discovery so cached production tool metadata cannot hide local MCP failures.
- Do not claim "full local E2E works" unless auth, tool discovery, and at least one local tool call passed in a fresh run.

## Quick Workflow

1. Confirm code-level checks:

```bash
npm test
npm run build
```

2. Confirm local services are present:

```bash
docker ps --format 'table {{.Names}}\t{{.Ports}}\t{{.Status}}' | rg 'rekindled-(mcp2|web)'
curl -k https://local.readwise.io:8000/o/.well-known/oauth-authorization-server
```

3. Log in without touching real CLI credentials:

```bash
TEMP_HOME="$(mktemp -d)"
trap 'rm -rf "$TEMP_HOME"' EXIT

printf '%s\n' "$READWISE_TOKEN" |
  HOME="$TEMP_HOME" \
  READWISE_MCP_URL=http://localhost:8103/mcp \
  npm run --silent dev -- login-with-token
```

4. Force local MCP tool discovery:

```bash
HOME="$TEMP_HOME" \
READWISE_MCP_URL=http://localhost:8103/mcp \
npm run --silent dev -- --refresh --help
```

5. Run read-only local tool calls:

```bash
HOME="$TEMP_HOME" \
READWISE_MCP_URL=http://localhost:8103/mcp \
npm run --silent dev -- --refresh --json readwise-list-highlights --page-size 1

HOME="$TEMP_HOME" \
READWISE_MCP_URL=http://localhost:8103/mcp \
npm run --silent dev -- --json reader-list-documents --limit 1
```

6. If Reader search is in scope, test it separately because it depends on backend embedding configuration:

```bash
HOME="$TEMP_HOME" \
READWISE_MCP_URL=http://localhost:8103/mcp \
npm run --silent dev -- --json reader-search-documents --query "local cli smoke" --limit 1
```

## Docker Log Triage

Capture a timestamp before reproducing a failure:

```bash
START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# reproduce the CLI failure here
docker logs --since "$START" "$(docker ps --format '{{.Names}}' | rg 'rekindled-mcp2' | head -n1)"
docker logs --since "$START" "$(docker ps --format '{{.Names}}' | rg 'rekindled-web' | head -n1)"
```

Read the logs by boundary:

- CLI error: user-facing symptom.
- `mcp2` logs: confirm request headers, MCP tool name, upstream URL, response status, and `is_error`.
- `web` logs: root cause for backend 4xx/5xx responses.

## Known Failure Signatures

| Symptom | Likely cause | Check or fix |
|---|---|---|
| CLI uses production MCP | Missing `READWISE_MCP_URL` or stale cache | Set `READWISE_MCP_URL=http://localhost:8103/mcp` and run with `--refresh`. |
| Login pollutes normal config | `HOME` was not isolated | Re-run with `HOME="$TEMP_HOME"` and inspect only `$TEMP_HOME/.readwise-cli.json`. |
| `mcp2` cannot reach `local.readwise.io` | Container DNS points at the wrong address for the web service | Inspect `docker exec <mcp2> getent hosts local.readwise.io`; prefer a durable compose/network fix over hardcoded transient IPs. |
| `CERTIFICATE_VERIFY_FAILED` from `mcp2` | Container does not trust the local mkcert root | Trust the local root CA inside the dev container or fix the dev image; avoid disabling TLS verification as the default answer. |
| `reader-search-documents` returns 500 and `mcp2` says `Unexpected error when searching Documents` | Backend web process is missing Reader document-search embedding config | In web logs, look for `api_key is None 1`; set `OPENAI_API_KEY_FOR_READER_DOCUMENT_SEARCH` for the running web process. |
| Other tools pass but Reader search fails | Local MCP path is working; the failing dependency is backend search config | Report partial E2E status precisely and include the backend log evidence. |

## Reporting

Report:

- Commands run and whether each exited 0.
- The local MCP URL used.
- Which Docker containers handled the request.
- Tool calls that passed, and tool calls blocked by backend config.
- Any container-local workaround applied, with a note that it disappears when containers are recreated.

Do not include secret values or raw document contents in the final report.
