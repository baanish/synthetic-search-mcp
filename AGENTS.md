# AGENTS.md

## Cursor Cloud specific instructions

This repo is `@baanish/synthetic-search-mcp`, a Node.js (ESM, `>=20`) TypeScript MCP server that
exposes two tools (`search` and `search_quota`) over **stdio**, backed by the hosted Synthetic API
(`https://api.synthetic.new`). There is no HTTP port, database, or frontend.

Standard commands live in `package.json` (`build`, `dev`, `start`) and `README.md`.
Notes that are not obvious from those files:

- `npm install` automatically runs the `prepare` script (`npm run build` → `tsc`), producing
  `dist/`. The update script already runs install on startup.
- Gates: `npm run typecheck` (`tsc --noEmit`, strict) and `npm test` (Vitest — unit,
  fetch-mocked integration, MCP transport tests covering both the 2025 era (in-memory
  pair) and the stateless 2026-07-28 revision plus legacy compatibility (in-process
  `createMcpHandler`), a spawned-bin `serveStdio` entry test (requires dist/,
  which `pretest` builds before every `npm test`, as do prepare and CI), and
  seeded fuzz tests). `npm run build`
  emits `dist/`. No linter is configured. CI runs typecheck + build + test on Node 20/22.
- `npm test` includes an opt-in live test that calls the real Synthetic API; it is skipped
  automatically unless `SYNTHETIC_API_KEY` is set (so CI runs unit/fuzz only).
- The server speaks JSON-RPC over stdio — you cannot `curl` it. Drive it with an MCP client.
  The `@modelcontextprotocol/client` `Client` + `StdioClientTransport` (a dev dependency)
  works: spawn `node dist/index.js`, `connect()` (with `versionNegotiation: { mode: 'auto' }`
  it probes `server/discover` and falls back to the 2025 `initialize` handshake), then
  `tools/list` → `tools/call` (`search` or `search_quota`).
- Runtime MCP dependency is the v2 SDK package `@modelcontextprotocol/server`
  (`serveStdio` serves both protocol eras; see README "Protocol support" for
  the era/pinning model).
- `search` and `search_quota` call the real Synthetic API and require `SYNTHETIC_API_KEY`. In
  Cursor Cloud this is provided as a secret and injected into the environment. The server still
  starts without the key (it logs a warning to stderr) but tool calls return an error until the
  key is set.
- Run locally with `npm run dev` or `node dist/index.js` (it then waits for stdio MCP traffic).
