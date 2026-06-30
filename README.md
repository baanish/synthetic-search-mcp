# @baanish/synthetic-search-mcp

A minimal [Model Context Protocol](https://modelcontextprotocol.io/) server that exposes [Synthetic](https://synthetic.new) web search over stdio.

It provides two MCP tools:

- `search`: run a web search against Synthetic and return a small set of results with `url`, `title`, `published`, and a truncated page-text snippet.
- `search_quota`: check the remaining hourly search quota (limit, requests, remaining, and reset time) so an agent can stay within budget.

The server is designed for local MCP clients such as Claude Code, Codex CLI, Cursor, and VS Code.

## Features

- Two focused tools: `search` and `search_quota`
- Fresh web results from Synthetic's `/v2/search` API
- Quota visibility via Synthetic's `/v2/quotas` (search is capped per hour)
- Clear `429` rate-limit errors, including `Retry-After` when provided
- Truncates extracted page text to about 2000 characters per result
- Repairs malformed control characters when `JSON.parse` fails, instead of giving up
- Bounded requests: a 30s timeout and a 10 MB response cap prevent hangs
- Drops results whose URL is not `http(s):`
- Reads credentials from `SYNTHETIC_API_KEY`
- Runs over stdio for local MCP integrations

## Requirements

- Node.js 20+
- A Synthetic API key in `SYNTHETIC_API_KEY`

## Installation

Use `npx`:

```bash
npx -y @baanish/synthetic-search-mcp
```

Or install globally:

```bash
npm install -g @baanish/synthetic-search-mcp
synthetic-search-mcp
```

## MCP Client Setup

The server command is:

```json
{
  "command": "npx",
  "args": ["-y", "@baanish/synthetic-search-mcp"],
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
      "args": ["-y", "@baanish/synthetic-search-mcp"],
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
args = ["-y", "@baanish/synthetic-search-mcp"]
env = { SYNTHETIC_API_KEY = "your_api_key_here" }
```

### Cursor

Add this to `.cursor/mcp.json` in your project or the equivalent Cursor MCP settings file:

```json
{
  "mcpServers": {
    "synthetic-search": {
      "command": "npx",
      "args": ["-y", "@baanish/synthetic-search-mcp"],
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
      "args": ["-y", "@baanish/synthetic-search-mcp"],
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

### `search_quota`

Report the remaining Synthetic search quota. Takes no input.

Output:

```json
{
  "hourly": {
    "limit": 250,
    "requests": 32,
    "remaining": 218,
    "renewsAt": "2026-06-26T21:00:00.000Z"
  },
  "subscription": {
    "limit": 750,
    "requests": 10,
    "remaining": 740,
    "renewsAt": "2026-07-01T00:00:00.000Z"
  }
}
```

Notes:

- Search is rate-limited per hour; `hourly` reflects the current window.
- `remaining` is derived as `limit - requests` (clamped at 0).
- A window is `null` if Synthetic does not report it.
- Checking the quota does not count against your search limit.

## Development

```bash
npm install
npm run build
```

Run locally:

```bash
SYNTHETIC_API_KEY=your_api_key_here npm run dev
```

### Testing

```bash
npm run typecheck   # tsc --noEmit over src + tests
npm test            # vitest: unit, integration, and fuzz tests
```

The suite includes an opt-in live smoke test that calls the real Synthetic API.
It runs only when `SYNTHETIC_API_KEY` is available (copy `.env.example` to `.env`
and add your key) and is skipped automatically otherwise — including in CI.

## Security

### Credential redaction

Upstream API error bodies are redacted of the active API key and bearer-token-like
material before they are returned over stdio. This prevents a hostile or
misconfigured upstream from reflecting the `SYNTHETIC_API_KEY` back through MCP
tool output.

### Transitive dependency advisories

`@modelcontextprotocol/sdk` is a production runtime dependency. It pulls in HTTP
middleware packages (`hono`, `@hono/node-server`, `express` → `path-to-regexp`,
`ajv` → `fast-uri`) that carry published CVEs. These advisories are
**production-transitive** — they are present in the installed dependency tree
shipped with this package — but this server uses **stdio only** and never invokes
the affected web-middleware code paths (serveStatic, cookies, JSX SSR, JWT
verify, toSSG, cache, ipRestriction, and similar).

We upgrade the SDK and apply npm `overrides` to force patched versions where
available. Remaining advisories after overrides:

- **esbuild** (dev-only, via `tsx`): affects the esbuild development server on
  Windows only; not used at runtime and not published in the npm tarball.
- **qs** (production-transitive via `express` in the MCP SDK): a `stringify`
  edge case; unreachable because this stdio server never runs Express query
  parsing or `qs.stringify` on untrusted input.

Any other production-transitive advisories that cannot be forced to a patch
without breaking the SDK are also considered unreachable on the stdio transport
and near-zero real-world exploitability for this package.

## License

MIT
