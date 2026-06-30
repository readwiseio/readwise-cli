# The Official Readwise CLI

A command-line interface for [Readwise](https://readwise.io) and [Reader](https://read.readwise.io). Search your documents & highlights, manage your reading list, tag and organize documents — all from the terminal.

Anything you can do in Readwise/Reader, your agent can now do for you.

## Install

```bash
npm install -g @readwise/cli
```

## Setup

### Interactive login (opens browser)

```bash
readwise login
```

### Access token login (for separate hosts like OpenClaw, or scripts)

Get your token from [readwise.io/access_token](https://readwise.io/access_token), then:

```bash
readwise login-with-token
# prompts for token (hidden input, not stored in shell history)
```

You can also pipe the token in:

```bash
echo "$READWISE_TOKEN" | readwise login-with-token
```

Credentials are stored in `~/.readwise-cli.json`. OAuth tokens refresh automatically.

## Commands

Run `readwise --help` to see all available commands, or `readwise <command> --help` for details on a specific command.

### Search documents

```bash
readwise reader-search-documents --query "machine learning"
readwise reader-search-documents --query "react" --category-in article
readwise reader-search-documents --query "notes" --location-in shortlist --limit 5
readwise reader-search-documents --query "physics" --published-date-gt 2024-01-01
```

### Search highlights

```bash
readwise readwise-search-highlights --vector-search-term "spaced repetition"
```

### List and inspect documents

```bash
readwise reader-list-documents --limit 5
readwise reader-list-documents --category article --location later
readwise reader-list-documents --tag "to-review"
readwise reader-get-document-details --document-id <document-id>
readwise reader-get-document-highlights --document-id <document-id>
```

> **Tip: seen vs unseen documents.** In the response, `firstOpenedAt: null` means the document is **unseen** (never opened). A non-null `firstOpenedAt` means it has been opened/seen. Use `reader-bulk-edit-document-metadata --documents '[{"document_id":"<id>","seen":true}]'` to mark a document as seen.

### Save a document

```bash
readwise reader-create-document --url "https://example.com/article"
readwise reader-create-document \
  --url "https://example.com" \
  --title "My Article" \
  --tags "reading-list,research" \
  --notes "Found via HN"
```

### Organize

```bash
# Tags
readwise reader-list-tags
readwise reader-add-tags-to-document --document-id <id> --tag-names "important,review"
readwise reader-remove-tags-from-document --document-id <id> --tag-names "old-tag"

# Move between locations (new/later/shortlist/archive)
readwise reader-move-documents --document-ids <id> --location archive

# Edit metadata
readwise reader-bulk-edit-document-metadata --documents '[{"document_id":"<id>","title":"Better Title"}]'
readwise reader-bulk-edit-document-metadata --documents '[{"document_id":"<id>","seen":true}]'
readwise reader-bulk-edit-document-metadata --documents '[{"document_id":"<id>","notes":"Updated notes"}]'
```

### Highlight management

```bash
readwise reader-add-tags-to-highlight --document-id <id> --highlight-document-id <id> --tag-names "key-insight"
readwise reader-remove-tags-from-highlight --document-id <id> --highlight-document-id <id> --tag-names "old-tag"
readwise reader-set-highlight-notes --document-id <id> --highlight-document-id <id> --notes "This connects to..."
```

### Export

```bash
readwise reader-export-documents
readwise reader-export-documents --since-updated "2024-06-01T00:00:00Z"
```

## Options

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON (for piping to `jq`, scripts, etc.) |
| `--refresh` | Force-refresh the command list from the server |
| `--debug` | Print sanitized diagnostic timings to stderr |
| `--help` | Show all commands or command-specific options |

## Troubleshooting

For support diagnostics, run a command with `--debug` or set `READWISE_CLI_DEBUG=1`:

```bash
readwise --debug reader-search-documents --query "machine learning" --limit 3
READWISE_CLI_DEBUG=1 readwise --version
```

Debug output is written to stderr as structured lines with a `run_id`, CLI version, Node version, platform, phase timings, and sanitized error details. Tokens and tool arguments are not logged.

## Configuration

Manage CLI settings with the `config` command. Settings are stored in `~/.readwise-cli.json` under the `config` key.

```bash
readwise config show              # show all settings with current values
readwise config get readonly      # get a single setting
readwise config set readonly true # set a setting
```

### Readonly mode

When `readonly` is enabled, only read-only tools (search, list, get) are available — write operations (create, move, tag, edit) are hidden from commands and the TUI. This is useful for agents or scripts that should never modify your library.

```bash
readwise config set readonly true
readwise --refresh   # re-fetch tool cache with annotations
readwise --help      # only read-only commands shown
```

To restore full access:

```bash
readwise config set readonly false
readwise login   # re-authentication required
```

> **Note:** Disabling readonly via the CLI logs you out and requires re-authentication. This prevents an AI agent from silently toggling readonly off and using write tools. The TUI settings screen is not affected — toggling readonly there does not require re-login.

## Examples

Pipe results to `jq`:

```bash
readwise reader-list-documents --limit 3 --json | jq '.results[].title'
```

## Skills

Pre-built workflows your AI agent can run. Install them with one command:

```bash
readwise skills install claude    # or codex, opencode
readwise skills list              # see all available skills
```

Browse and contribute skills at [github.com/readwiseio/readwise-skills](https://github.com/readwiseio/readwise-skills).

## Looking for MCP?

Using Claude Desktop, ChatGPT, or another AI app? Connect Readwise via MCP — no terminal needed. [Set up Readwise MCP →](https://readwise.io/mcp)

## How it works

The CLI connects to the [Readwise MCP server](https://mcp2.readwise.io) internally, auto-discovers available tools, and exposes each one as a CLI command. The tool list is cached locally for 24 hours.

## Development

```bash
git clone https://github.com/readwise/readwise-cli && cd readwise-cli
npm install
npm run build

# Run without building
npx tsx src/index.ts --help
```
