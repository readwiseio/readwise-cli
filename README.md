# readwise-cli

A command-line interface for [Readwise](https://readwise.io) and [Reader](https://read.readwise.io). Search your highlights, manage your reading list, tag and organize documents — all from the terminal.

Commands are auto-discovered from the Readwise API, so the CLI stays up to date as new features are added.

## Install

```bash
git clone <repo-url> && cd readwise-cli
npm install
npm run build
npm link
```

## Setup

Log in to your Readwise account (opens browser):

```bash
readwise-cli login
```

Tokens are stored in `~/.readwise-cli.json` and refresh automatically.

## Commands

Run `readwise-cli --help` to see all available commands, or `readwise-cli <command> --help` for details on a specific command.

### Search documents

```bash
readwise-cli reader-search-documents --query "machine learning"
readwise-cli reader-search-documents --query "react" --category-in article
readwise-cli reader-search-documents --query "notes" --location-in shortlist --limit 5
readwise-cli reader-search-documents --query "physics" --published-date-gt 2024-01-01
```

### Search highlights

```bash
readwise-cli readwise-search-highlights --vector-search-term "spaced repetition"
```

### List and inspect documents

```bash
readwise-cli reader-list-documents --limit 5
readwise-cli reader-list-documents --category article --location later
readwise-cli reader-list-documents --tag "to-review"
readwise-cli reader-get-document-details --id <document-id>
readwise-cli reader-get-document-highlights --id <document-id>
```

### Save a document

```bash
readwise-cli reader-create-document --url "https://example.com/article"
readwise-cli reader-create-document \
  --url "https://example.com" \
  --title "My Article" \
  --tags "reading-list,research" \
  --notes "Found via HN"
```

### Organize

```bash
# Tags
readwise-cli reader-list-tags
readwise-cli reader-add-tags-to-document --document-id <id> --tags "important,review"
readwise-cli reader-remove-tags-from-document --document-id <id> --tags "old-tag"

# Move between locations (new/later/shortlist/archive)
readwise-cli reader-move-document --document-id <id> --location archive

# Edit metadata
readwise-cli reader-edit-document-metadata --document-id <id> --title "Better Title"
readwise-cli reader-set-document-notes --document-id <id> --notes "Updated notes"
```

### Highlight management

```bash
readwise-cli reader-add-tags-to-highlight --highlight-id <id> --tags "key-insight"
readwise-cli reader-remove-tags-from-highlight --highlight-id <id> --tags "old-tag"
readwise-cli reader-set-highlight-notes --highlight-id <id> --notes "This connects to..."
```

### Export

```bash
readwise-cli reader-export-documents
readwise-cli reader-export-documents --since-updated "2024-06-01T00:00:00Z"
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
readwise-cli reader-list-documents --limit 3 --json | jq '.[].title'
```

## Development

```bash
# Run without building
npx tsx src/index.ts --help

# Build
npm run build
```

## How it works

The CLI connects to the [Readwise MCP server](https://readwise.io/mcp2) internally, auto-discovers available tools, and exposes each one as a CLI command. The tool list is cached locally for 24 hours.
