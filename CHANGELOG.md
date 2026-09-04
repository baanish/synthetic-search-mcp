# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.0]

### Added

- Support for the stateless MCP protocol revision
  [2026-07-28](https://blog.modelcontextprotocol.io/posts/2026-07-28/): when a
  client opens with the modern protocol the server answers every request
  statelessly — no `initialize` handshake, no `Mcp-Session-Id`, with the
  protocol version, client identity, and client capabilities carried in the
  per-request `_meta` envelope. The server implements the spec-required
  `server/discover` RPC; protocol state travels on the request itself, so no
  server-side session state is required. README.md ("Protocol support")
  documents how the stdio entry serves both eras.
- Graceful `SIGINT`/`SIGTERM` shutdown (closes the pinned instance and the
  transport) and a non-zero exit code when the serving entry reports an
  out-of-band failure, so a host can no longer misread a dead server as a
  clean exit-0 run.
- `npm test` now rebuilds `dist/` first (`pretest`), so the spawned-bin
  `serveStdio` tests always run against current source; the CI pack job's
  smoke test probes both the legacy `initialize` handshake and the stateless
  `server/discover` opening against the packed tarball.
- 2025-era clients keep working from the same server factory: a connection
  that opens with the legacy `initialize` handshake is pinned to a 2025-era
  instance and served exactly as before (the stdio entry's default
  `legacy: 'serve'` posture). No configuration is required.
- Tests now cover both protocol eras: the 2025-era in-memory transport tests,
  plus stateless 2026-07-28 and legacy-compatibility tests driven through the
  in-process `createMcpHandler` HTTP entry.

### Changed

- **Breaking:** migrated the runtime from `@modelcontextprotocol/sdk` (v1.x)
  to the v2 SDK package `@modelcontextprotocol/server`; tests use
  `@modelcontextprotocol/client`. Programmatic importers of `createServer`
  now receive a v2 `McpServer`, and the stdio entry point is `serveStdio`
  instead of `server.connect(new StdioServerTransport())`.
- **Breaking:** `zod` bumped to `^4.2.0` (the v2 SDK's schema dialect) and the
  `search` tool's `inputSchema` is now a `z.object(...)` Standard Schema
  instead of a raw Zod shape.
- Removed the npm `overrides` that pinned patched transitive versions of the
  v1 SDK's web-middleware dependency tree (`hono`, `@hono/node-server`,
  `path-to-regexp`, `fast-uri`, `ip-address`, `qs`): the v2
  `@modelcontextprotocol/server` runtime dependency no longer pulls in any of
  those packages, so the overrides and the advisory notes about them no longer
  apply.

## [2.0.0]

### Security

- Upstream API error bodies are redacted of the active API key and
  bearer-token-like material before they are returned over stdio, so a reflected
  credential cannot leak through MCP tool output. Redaction is also applied as a
  final backstop at the tool boundary, covering paths that echo upstream content
  without redacting (e.g. the `JSON.parse` snippet surfaced by
  `parseSyntheticResponse` for a malformed 2xx body).
- Upgraded `@modelcontextprotocol/sdk` to 1.29.x and added npm `overrides` for
  patched transitive dependencies (`hono`, `@hono/node-server`, `path-to-regexp`,
  `fast-uri`, `ip-address`). Remaining production-transitive advisories that
  cannot be forced to a patch without breaking the SDK are documented in
  README.md; they are unreachable on the stdio transport.

### Changed

- **Breaking:** minimum Node.js version is now 20 (`engines.node` `>=20`). Node
  18 is end-of-life; CI runs on Node 20/22 only.

## [1.1.0]

### Added

- `search_quota` tool: reports the remaining hourly search quota (and the
  subscription-period quota) from Synthetic's `/v2/quotas` endpoint, so an agent
  can check its budget before searching. Checking the quota does not count
  against the search limit.
- Explicit `429` rate-limit handling for `search`: a clear message that points
  at `search_quota`, including `Retry-After` when the API provides it.
- Per-request timeout (default 30s) so a hung or slow Synthetic API response can
  no longer block a tool call indefinitely.
- Response-size guard: responses whose `Content-Length` exceeds 10 MB are
  rejected instead of being buffered into memory.
- HTTP(S) URL validation in result normalization — results whose `url` is not an
  `http:`/`https:` URL (e.g. `javascript:`, `data:`, `file:`) are dropped.
- Test suite (vitest): unit, fetch-mocked integration, MCP in-memory transport,
  and seeded fuzz tests, plus an opt-in live API smoke test.
- GitHub Actions CI running typecheck, build, and tests on Node 20/22.
- `.env.example` and a `typecheck`/`test` npm scripts.

### Fixed

- `sanitizeJsonResponse` no longer leaves invalid JSON when a backslash is
  immediately followed by a raw control character inside a string value.
- `truncateText` no longer returns output longer than the limit for small
  limits, and no longer emits a lone UTF-16 surrogate when a cut splits an
  astral character (e.g. an emoji).
- Network/DNS/TLS failures now surface the underlying cause instead of an opaque
  `fetch failed` message.

### Changed

- Raised the minimum Node.js version to 20 (`engines.node` `>=20`). Node 18 is
  end-of-life and the dev/test toolchain (Vite 7, via Vitest) requires
  Node `^20.19 || >=22.12`; the published runtime targets Node 20/22.
- Migrated the tool registration from the deprecated `server.tool(...)` to
  `server.registerTool(...)`, adding `readOnlyHint`/`openWorldHint` annotations.
- `JSON.parse` is now attempted directly first and only falls back to the
  control-character sanitizer when the upstream response is malformed.
- Internals split into `src/synthetic.ts` (core, side-effect free) and
  `src/index.ts` (server wiring + entry point) so the logic is unit-testable.

## [1.0.0]

- Initial release: a single `search` MCP tool over stdio backed by the Synthetic
  `/v2/search` API.
