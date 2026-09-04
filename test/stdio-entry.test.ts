import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

// The real shipped entry point: spawn the built bin and drive it over stdio,
// as a host would. Requires dist/ — produced by `npm run build`, which the
// `pretest` script runs before every `npm test` (as do `prepare` and CI), so
// the spawned bin always matches the current source.
const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

// Blank the API key in the child env so a developer's real .env key can never
// turn these tests into live API calls; the missing-key error result is the
// deterministic outcome the dispatch test asserts on.
const env = { ...process.env, SYNTHETIC_API_KEY: "" } as Record<string, string>;

let client: Client | null = null;

afterEach(async () => {
  await client?.close();
  client = null;
});

/** Connect a client to the built bin through the serveStdio entry. */
async function connectBin(clientOptions?: ConstructorParameters<typeof Client>[1]): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin],
    env,
    stderr: "ignore",
  });
  client = new Client({ name: "stdio-entry-test", version: "0.0.0" }, clientOptions);
  await client.connect(transport);
  return client;
}

describe("serveStdio entry (spawned dist/index.js)", () => {
  it("negotiates the stateless 2026-07-28 era via server/discover", async () => {
    const c = await connectBin({ versionNegotiation: { mode: "auto" } });

    expect(c.getProtocolEra()).toBe("modern");

    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["search", "search_quota"]);
  }, 30_000);

  it("dispatches a tool call end-to-end over the stateless era", async () => {
    const c = await connectBin({ versionNegotiation: { mode: "auto" } });

    const result = await c.callTool({ name: "search", arguments: { query: "hello" } });

    // No API key in the child env: the tool boundary returns its documented
    // (redacted) error result instead of touching the network.
    expect(result.isError).toBe(true);
    const content = result.content as { type: string; text: string }[];
    expect(content[0].text).toContain("SYNTHETIC_API_KEY");
  }, 30_000);

  it("still serves a 2025-era handshake client from the same entry", async () => {
    const c = await connectBin();

    expect(c.getProtocolEra()).toBe("legacy");

    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["search", "search_quota"]);
  }, 30_000);
});
