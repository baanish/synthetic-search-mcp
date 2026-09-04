#!/usr/bin/env node

import { McpServer, UnsupportedProtocolVersionError } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import {
  SEARCH_QUOTA_TOOL_DESCRIPTION,
  SEARCH_TOOL_DESCRIPTION,
  type SearchOptions,
  runQuotaTool,
  runSearchTool,
} from "./synthetic.js";

export const SERVER_NAME = "@baanish/synthetic-search-mcp";
export const SERVER_VERSION = "3.0.0";

/**
 * Build an MCP server exposing the `search` tool. `options` are forwarded to the
 * search implementation, which lets tests inject a fetch stub / config without
 * touching the network.
 *
 * The returned instance is protocol-era agnostic: the v2 serving entries call
 * this as a factory and serve both the stateless 2026-07-28 revision and
 * 2025-era clients from it.
 */
export function createServer(options: SearchOptions = {}): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  server.registerTool(
    "search",
    {
      description: SEARCH_TOOL_DESCRIPTION,
      inputSchema: z.object({
        query: z
          .string()
          .trim()
          .min(1, "Query is required.")
          .describe("The exact web search query to run."),
      }),
      annotations: {
        title: "Synthetic Web Search",
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ query }) => runSearchTool(query, options),
  );

  server.registerTool(
    "search_quota",
    {
      description: SEARCH_QUOTA_TOOL_DESCRIPTION,
      annotations: {
        title: "Synthetic Search Quota",
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async () => runQuotaTool(options),
  );

  return server;
}

function main(): void {
  if (!process.env.SYNTHETIC_API_KEY?.trim()) {
    console.error(
      "synthetic-search-mcp: SYNTHETIC_API_KEY is not set. The server will start, but `search` and `search_quota` calls will fail until the variable is configured.",
    );
  }

  // Default legacy posture is 'serve': a 2025-era `initialize` opening pins the
  // connection to a 2025-era instance from the same factory, while a
  // 2026-07-28 opening is served statelessly (no handshake, no session).
  // Out-of-band failures (e.g. a wire-transport start error) are reported only
  // through onerror and swallowed by the entry, so log them and mark the exit
  // code — otherwise a server whose transport failed to start would exit 0,
  // reading as a clean run to a host. UnsupportedProtocolVersionError is the
  // exception: it is the spec's recoverable negotiation signal (the client
  // falls back to the 2025 handshake and the connection continues), so a
  // successful fallback session must still exit 0.
  const handle = serveStdio(() => createServer(), {
    onerror: (error) => {
      console.error(`synthetic-search-mcp: ${error.message}`);
      if (!(error instanceof UnsupportedProtocolVersionError)) {
        process.exitCode = 1;
      }
    },
  });

  // Graceful teardown on shutdown signals: close the pinned instance and the
  // transport, then exit with whatever exit code the run earned (an onerror
  // failure keeps its non-zero code). A second signal falls through to the
  // default disposition instead of waiting on the close.
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void handle.close().finally(() => process.exit(process.exitCode ?? 0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

/**
 * True when this module is the program entry point. Both sides are resolved
 * through `realpath` so the check still holds when the binary is invoked via a
 * symlink — which is exactly how npm/npx run the `bin` (a node_modules/.bin
 * symlink). A plain `import.meta.url === pathToFileURL(argv[1])` comparison
 * fails there because Node resolves symlinks for the module URL but not for
 * `process.argv[1]`. Returns false (so the server does not start) when invoked
 * by `import`, where `argv[1]` is the test runner / importer.
 */
export function isMainModule(importMetaUrl: string, invokedPath: string | undefined): boolean {
  if (!invokedPath) {
    return false;
  }

  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(invokedPath);
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(
      `synthetic-search-mcp failed to start: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exit(1);
  }
}
