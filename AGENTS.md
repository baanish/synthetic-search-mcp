# AGENTS.md

## Cursor Cloud specific instructions

This repo is `@baanish/synthetic-search-mcp`, a Node.js (ESM, `>=18`) TypeScript MCP server that
exposes one tool (`search`) over **stdio**, backed by the hosted Synthetic API
(`https://api.synthetic.new`). There is no HTTP port, database, or frontend.

Standard commands live in `package.json` (`build`, `dev`, `start`) and `README.md`.
Notes that are not obvious from those files:

- `npm install` automatically runs the `prepare` script (`npm run build` → `tsc`), producing
  `dist/`. The update script already runs install on startup.
- There is no test suite and no linter configured. `npm run build` (`tsc` strict) is the
  type-check / static gate.
- The server speaks JSON-RPC over stdio — you cannot `curl` it. Drive it with an MCP client.
  The `@modelcontextprotocol/sdk` `Client` + `StdioClientTransport` (already a dependency) works:
  spawn `node dist/index.js`, then `initialize` → `tools/list` → `tools/call` the `search` tool.
- `search` calls the real Synthetic API and requires `SYNTHETIC_API_KEY`. In Cursor Cloud this is
  provided as a secret and injected into the environment. The server still starts without the key
  (it logs a warning to stderr) but `search` calls return an error until the key is set.
- Run locally with `npm run dev` or `node dist/index.js` (it then waits for stdio MCP traffic).
