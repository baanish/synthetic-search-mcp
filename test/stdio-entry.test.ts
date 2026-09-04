import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { SERVER_NAME } from "../src/index.js";

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

  // Regression: an unsupported-version server/discover probe is a recoverable
  // negotiation error — the client falls back to the 2025 handshake — so the
  // run must still exit 0. Driven over the raw wire (not an SDK client) so the
  // child's exit code can be asserted.
  it("exits 0 when an unsupported-version probe falls back to a successful legacy session", async () => {
    const child = spawn(process.execPath, [bin], { env, stdio: ["pipe", "pipe", "ignore"] });

    let buffer = "";
    const queued: string[] = [];
    const waiting: ((line: string) => void)[] = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const resolve = waiting.shift();
        if (resolve) resolve(line);
        else queued.push(line);
        newline = buffer.indexOf("\n");
      }
    });
    const nextMessage = () =>
      new Promise<string>((resolve) => {
        const buffered = queued.shift();
        if (buffered !== undefined) resolve(buffered);
        else waiting.push(resolve);
      });
    const send = (message: unknown) =>
      new Promise<void>((resolve, reject) => {
        child.stdin.write(`${JSON.stringify(message)}\n`, (error) => (error ? reject(error) : resolve()));
      });

    // 1. Probe with a modern revision this server does not support.
    await send({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2027-01-01",
          "io.modelcontextprotocol/clientInfo": { name: "stdio-entry-test", version: "0.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    });
    const discoverReply = JSON.parse(await nextMessage()) as { error?: { code: number; data?: { supported?: string[] } } };
    expect(discoverReply.error?.code).toBe(-32022);
    expect(discoverReply.error?.data?.supported).toEqual(["2026-07-28"]);

    // 2. Fall back to the 2025 handshake and use the connection normally.
    await send({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "stdio-entry-test", version: "0.0.0" },
      },
    });
    const initReply = JSON.parse(await nextMessage()) as { result?: { serverInfo?: { name?: string } } };
    expect(initReply.result?.serverInfo?.name).toBe(SERVER_NAME);

    await send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    const toolsReply = JSON.parse(await nextMessage()) as { result?: { tools?: { name: string }[] } };
    expect(toolsReply.result?.tools?.map((t) => t.name).sort()).toEqual(["search", "search_quota"]);

    // 3. Normal shutdown (stdin EOF): the successful run exits 0.
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
      child.stdin.end();
    });
    expect(exitCode).toBe(0);
  }, 30_000);
});
