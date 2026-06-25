# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0]

### Added

- Per-request timeout (default 30s) so a hung or slow Synthetic API response can
  no longer block a tool call indefinitely.
- Response-size guard: responses whose `Content-Length` exceeds 10 MB are
  rejected instead of being buffered into memory.
- HTTP(S) URL validation in result normalization — results whose `url` is not an
  `http:`/`https:` URL (e.g. `javascript:`, `data:`, `file:`) are dropped.
- Test suite (vitest): unit, fetch-mocked integration, MCP in-memory transport,
  and seeded fuzz tests, plus an opt-in live API smoke test.
- GitHub Actions CI running typecheck, build, and tests on Node 18/20/22.
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

- Migrated the tool registration from the deprecated `server.tool(...)` to
  `server.registerTool(...)`, adding `readOnlyHint`/`openWorldHint` annotations.
- `JSON.parse` is now attempted directly first and only falls back to the
  control-character sanitizer when the upstream response is malformed.
- Internals split into `src/synthetic.ts` (core, side-effect free) and
  `src/index.ts` (server wiring + entry point) so the logic is unit-testable.

## [1.0.0]

- Initial release: a single `search` MCP tool over stdio backed by the Synthetic
  `/v2/search` API.
