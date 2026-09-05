import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { spawn, type ChildProcess } from "node:child_process";
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
// deterministic outcome the dispatch tests assert on.
const env = { ...process.env, SYNTHETIC_API_KEY: "" } as Record<string, string>;

let client: Client | null = null;

afterEach(async () => {
  await client?.close();
  client = null;
});

/** Connect an SDK client to the built bin through the serveStdio entry. */
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

type Wire = {
  send: (message: unknown) => Promise<void>;
  sendRaw: (text: string) => Promise<void>;
  nextMessage: () => Promise<string>;
};

/**
 * Spawn the bin and expose its stdout as newline-delimited messages, for
 * wire-level scenarios (and exit codes) the SDK client does not surface.
 */
function spawnBinWire(options: { stderr?: "ignore" | "pipe" } = {}): {
  child: ChildProcess;
  wire: Wire;
  stderr: () => string;
  endInput: () => void;
} {
  const child = spawn(process.execPath, [bin], {
    env,
    stdio: ["pipe", "pipe", options.stderr === "pipe" ? "pipe" : "ignore"],
  });
  // stdio[0] and stdio[1] are always pipes here; the spawn overload with a
  // non-literal stdio array types the streams as nullable.
  const stdin = child.stdin!;
  const stdout = child.stdout!;
  let stdoutBuffer = "";
  const queued: string[] = [];
  const waiting: ((line: string) => void)[] = [];
  stdout.setEncoding("utf8");
  stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let newline = stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      const resolve = waiting.shift();
      if (resolve) resolve(line);
      else queued.push(line);
      newline = stdoutBuffer.indexOf("\n");
    }
  });
  let stderrText = "";
  if (options.stderr === "pipe" && child.stderr) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrText += chunk;
    });
  }
  const write = (text: string) =>
    new Promise<void>((resolve, reject) => {
      stdin.write(`${text}\n`, (error) => (error ? reject(error) : resolve()));
    });
  return {
    child,
    wire: {
      send: (message) => write(JSON.stringify(message)),
      sendRaw: write,
      nextMessage: () =>
        new Promise<string>((resolve) => {
          const buffered = queued.shift();
          if (buffered !== undefined) resolve(buffered);
          else waiting.push(resolve);
        }),
    },
    stderr: () => stderrText,
    endInput: () => stdin.end(),
  };
}

/** The child's exit code after `close` ends the session (EOF or signal). */
function exitCodeOf(child: ChildProcess, close: () => void): Promise<number | null> {
  return new Promise((resolve) => {
    child.once("exit", (code) => resolve(code));
    close();
  });
}

const envelopeMeta = (version: string) => ({
  "io.modelcontextprotocol/protocolVersion": version,
  "io.modelcontextprotocol/clientInfo": { name: "stdio-entry-test", version: "0.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
});

const discoverRequest = (version: string, id: number) => ({
  jsonrpc: "2.0",
  id,
  method: "server/discover",
  params: { _meta: envelopeMeta(version) },
});

const modernToolsList = (id: number) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/list",
  params: { _meta: envelopeMeta("2026-07-28") },
});

const toolNames = (message: string) =>
  (JSON.parse(message) as { result?: { tools?: { name: string }[] } }).result?.tools?.map((t) => t.name).sort();

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

  it("dispatches search_quota through the modern-era pin", async () => {
    const c = await connectBin({ versionNegotiation: { mode: "auto" } });

    const result = await c.callTool({ name: "search_quota", arguments: {} });

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

  it("dispatches a tool call through the 2025-era pin", async () => {
    const c = await connectBin();

    const result = await c.callTool({ name: "search", arguments: { query: "hello" } });

    expect(result.isError).toBe(true);
    const content = result.content as { type: string; text: string }[];
    expect(content[0].text).toContain("SYNTHETIC_API_KEY");
  }, 30_000);
});

describe("serveStdio lifecycle (raw wire, spawned bin)", () => {
  it("exits 0 when an unsupported-version probe falls back to a successful legacy session", async () => {
    const { child, wire, endInput } = spawnBinWire();

    // 1. Probe with a modern revision this server does not support.
    await wire.send(discoverRequest("2027-01-01", 1));
    const discoverReply = JSON.parse(await wire.nextMessage()) as {
      error?: { code: number; data?: { supported?: string[] } };
    };
    expect(discoverReply.error?.code).toBe(-32022);
    expect(discoverReply.error?.data?.supported).toEqual(["2026-07-28"]);

    // 2. Fall back to the 2025 handshake and use the connection normally.
    await wire.send({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "stdio-entry-test", version: "0.0.0" },
      },
    });
    const initReply = JSON.parse(await wire.nextMessage()) as { result?: { serverInfo?: { name?: string } } };
    expect(initReply.result?.serverInfo?.name).toBe(SERVER_NAME);

    await wire.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await wire.send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    expect(toolNames(await wire.nextMessage())).toEqual(["search", "search_quota"]);

    // 3. Normal shutdown (stdin EOF): the successful run exits 0.
    expect(await exitCodeOf(child, endInput)).toBe(0);
  }, 30_000);

  it("exits 0 when a late legacy initialize is rejected on a modern-pinned connection", async () => {
    const { child, wire, endInput } = spawnBinWire();

    // Pin the modern era and serve over it.
    await wire.send(discoverRequest("2026-07-28", 1));
    const discoverReply = JSON.parse(await wire.nextMessage()) as {
      result?: { supportedVersions?: string[] };
    };
    expect(discoverReply.result?.supportedVersions).toEqual(["2026-07-28"]);
    await wire.send(modernToolsList(2));
    expect(toolNames(await wire.nextMessage())).toEqual(["search", "search_quota"]);

    // A legacy initialize on the modern-pinned connection is answered in-band
    // with the corrective -32022 error; the session keeps serving.
    await wire.send({
      jsonrpc: "2.0",
      id: 3,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "stdio-entry-test", version: "0.0.0" },
      },
    });
    const rejection = JSON.parse(await wire.nextMessage()) as { error?: { code: number } };
    expect(rejection.error?.code).toBe(-32022);

    await wire.send(modernToolsList(4));
    expect(toolNames(await wire.nextMessage())).toEqual(["search", "search_quota"]);

    // Normal shutdown: the successful session still exits 0.
    expect(await exitCodeOf(child, endInput)).toBe(0);
  }, 30_000);

  it("exits 0 on idle SIGTERM and SIGINT", async () => {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      const { child } = spawnBinWire();
      // Let the child finish startup before signaling.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await exitCodeOf(child, () => child.kill(signal))).toBe(0);
    }
  }, 30_000);

  it("exits 1 when the first message is a JSON-RPC response", async () => {
    const { child, wire, endInput } = spawnBinWire();

    await wire.send({ jsonrpc: "2.0", id: 1, result: {} });

    expect(await exitCodeOf(child, endInput)).toBe(1);
  }, 30_000);

  it("exits 0 for an unparseable frame (the SDK transport drops it silently)", async () => {
    const { child, wire, stderr, endInput } = spawnBinWire({ stderr: "pipe" });

    await wire.sendRaw("this is not json");

    expect(await exitCodeOf(child, endInput)).toBe(0);
    // Only the startup warning is on stderr: the ReadBuffer swallows the
    // SyntaxError without reporting it.
    expect(stderr().trim().split("\n")).toHaveLength(1);
  }, 30_000);

  it("exits 1 for a schema-invalid JSON frame, logging one capped stderr line", async () => {
    const { child, wire, stderr, endInput } = spawnBinWire({ stderr: "pipe" });

    await wire.send({ foo: 1 });

    expect(await exitCodeOf(child, endInput)).toBe(1);
    const lines = stderr().trim().split("\n");
    // The startup warning plus exactly one single-line, length-capped report.
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("invalid_union");
    expect(lines[1].length).toBeLessThan(400);
  }, 30_000);
});
