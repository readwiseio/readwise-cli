# readwise

A command-line interface for [Readwise](https://readwise.io) and [Reader](https://read.readwise.io). Search your highlights, manage your reading list, tag and organize documents — all from the terminal.

Commands are auto-discovered from the Readwise API, so the CLI stays up to date as new features are added.

## Install

```bash
git clone <repo-url> && cd readwise
npm install
npm run build
npm link
```

## Setup

### Interactive login (opens browser)

```bash
readwise login
```

### Access token login (for scripts/CI)

Get your token from [readwise.io/access_token](https://readwise.io/access_token), then:

```bash
readwise login-with-token
# prompts for token (hidden input, not stored in shell history)
```

You can also pipe the token in:

```bash
echo "$READWISE_TOKEN" | readwise login-with-token
```

Credentials are stored in `~/.readwise.json`. OAuth tokens refresh automatically.

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
readwise reader-get-document-details --id <document-id>
readwise reader-get-document-highlights --id <document-id>
```

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
readwise reader-add-tags-to-document --document-id <id> --tags "important,review"
readwise reader-remove-tags-from-document --document-id <id> --tags "old-tag"

# Move between locations (new/later/shortlist/archive)
readwise reader-move-document --document-id <id> --location archive

# Edit metadata
readwise reader-edit-document-metadata --document-id <id> --title "Better Title"
readwise reader-set-document-notes --document-id <id> --notes "Updated notes"
```

### Highlight management

```bash
readwise reader-add-tags-to-highlight --highlight-id <id> --tags "key-insight"
readwise reader-remove-tags-from-highlight --highlight-id <id> --tags "old-tag"
readwise reader-set-highlight-notes --highlight-id <id> --notes "This connects to..."
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
| `--help` | Show all commands or command-specific options |

## Examples

Pipe results to `jq`:

```bash
readwise reader-list-documents --limit 3 --json | jq '.[].title'
```

## Development

```bash
# Run without building
npx tsx src/index.ts --help

# Build
npm run build
```

## How it works

The CLI connects to the [Readwise MCP server](https://mcp2.readwise.io) internally, auto-discovers available tools, and exposes each one as a CLI command. The tool list is cached locally for 24 hours.
