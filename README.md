# synthetic-search-mcp

A minimal [Model Context Protocol](https://modelcontextprotocol.io/) server that exposes Synthetic web search over stdio.

It provides one MCP tool:

- `search`: run a web search against Synthetic and return a small set of results with `url`, `title`, `published`, and a truncated page-text snippet.

The server is designed for local MCP clients such as Claude Code, Codex CLI, Cursor, and VS Code.

## Features

- One focused tool: `search`
- Fresh web results from Synthetic's `/v2/search` API
- Truncates extracted page text to about 2000 characters per result
- Sanitizes malformed control characters before `JSON.parse`
- Reads credentials from `SYNTHETIC_API_KEY`
- Runs over stdio for local MCP integrations

## Requirements

- Node.js 18+
- A Synthetic API key in `SYNTHETIC_API_KEY`

## Installation

Use `npx`:

```bash
npx -y synthetic-search-mcp
```

Or install globally:

```bash
npm install -g synthetic-search-mcp
synthetic-search-mcp
```

## MCP Client Setup

The server command is:

```json
{
  "command": "npx",
  "args": ["-y", "synthetic-search-mcp"],
  "env": {
    "SYNTHETIC_API_KEY": "your_api_key_here"
  }
}
```

### Claude Code

Add a project-level `.mcp.json` file:

```json
{
  "mcpServers": {
    "synthetic-search": {
      "command": "npx",
      "args": ["-y", "synthetic-search-mcp"],
      "env": {
        "SYNTHETIC_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

### Codex CLI

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.synthetic-search]
command = "npx"
args = ["-y", "synthetic-search-mcp"]
env = { SYNTHETIC_API_KEY = "your_api_key_here" }
```

### Cursor

Add this to `.cursor/mcp.json` in your project or the equivalent Cursor MCP settings file:

```json
{
  "mcpServers": {
    "synthetic-search": {
      "command": "npx",
      "args": ["-y", "synthetic-search-mcp"],
      "env": {
        "SYNTHETIC_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

### VS Code / GitHub Copilot

Add this to `.vscode/mcp.json`:

```json
{
  "servers": {
    "synthetic-search": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "synthetic-search-mcp"],
      "env": {
        "SYNTHETIC_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

## Tool

### `search`

Search the public web through Synthetic.

Input:

```json
{
  "query": "latest model context protocol news"
}
```

Output:

```json
[
  {
    "url": "https://example.com/article",
    "title": "Example result",
    "text": "Truncated extracted page text...",
    "published": "2026-03-12T10:15:00.000Z"
  }
]
```

Notes:

- Synthetic only supports a single `query` parameter.
- Result text is truncated to keep MCP context manageable.
- `published` may be `null` when the source does not provide a date.

## Development

```bash
npm install
npm run build
```

Run locally:

```bash
SYNTHETIC_API_KEY=your_api_key_here npm run dev
```

## License

MIT
