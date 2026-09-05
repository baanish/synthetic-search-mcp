import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { installShutdownHandlers, NEGOTIATION_FABRIC_PREFIXES, SERVER_NAME } from "../src/index.js";

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
const spawnedBins: { child: ChildProcess; exited: Promise<void> }[] = [];

afterEach(async () => {
  await client?.close();
  client = null;
  // A failed assertion can abort a raw-wire test before it ends its spawned
  // bin; kill any survivor so one test cannot leak a server into the suite.
  for (const { child, exited } of spawnedBins.splice(0)) {
    if (child.exitCode === null && child.signalCode === null && !child.killed) {
      child.kill();
    }
    await exited;
  }
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
  exited: Promise<void>;
} {
  const child = spawn(process.execPath, [bin], {
    env,
    stdio: ["pipe", "pipe", options.stderr === "pipe" ? "pipe" : "ignore"],
  });
  // Resolves exactly once whether the child exits, is killed, or is reaped by
  // the afterEach survivor cleanup.
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  spawnedBins.push({ child, exited });
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
    exited,
  };
}

/**
 * The child's termination after `close` ends the session. Resolves on the
 * close event, not exit: stdio streams may still hold undrained output when
 * exit fires, and the stderr assertions read them.
 */
function terminationOf(
  child: ChildProcess,
  close: () => void,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
    close();
  });
}

async function exitCodeOf(child: ChildProcess, close: () => void): Promise<number | null> {
  return (await terminationOf(child, close)).code;
}

/** Just the process surface installShutdownHandlers touches, for unit tests. */
class FakeProcess extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  killedWith: string | null = null;
  exitedWith: number | null = null;
  kill(pid: number, signal: string): boolean {
    this.killedWith = signal;
    return pid === this.pid;
  }
  exit(code?: number): void {
    this.exitedWith = code ?? 0;
  }
}

describe("installShutdownHandlers", () => {
  it("exits with the earned code once the graceful close settles", async () => {
    const target = new FakeProcess();
    target.exitCode = 1; // earned by an earlier onerror report
    let resolveClose: (() => void) | undefined;
    installShutdownHandlers(
      { close: () => new Promise<void>((resolve) => (resolveClose = resolve)) },
      target as unknown as NodeJS.Process,
    );

    target.emit("SIGTERM", "SIGTERM");
    expect(target.exitedWith).toBeNull(); // still closing

    resolveClose!();
    await new Promise((resolve) => setTimeout(resolve, 0)); // let .finally run
    expect(target.exitedWith).toBe(1);
    expect(target.killedWith).toBeNull();
  });

  it("escalates a second signal to the default disposition while the close is pending", () => {
    const target = new FakeProcess();
    installShutdownHandlers(
      { close: () => new Promise<never>(() => {}) }, // never settles
      target as unknown as NodeJS.Process,
    );

    target.emit("SIGINT", "SIGINT");
    expect(target.killedWith).toBeNull();
    expect(target.exitedWith).toBeNull();

    target.emit("SIGTERM", "SIGTERM");
    expect(target.killedWith).toBe("SIGTERM");
    expect(target.exitedWith).toBeNull();
    expect(target.listenerCount("SIGINT")).toBe(0);
    expect(target.listenerCount("SIGTERM")).toBe(0);
  });
});

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

describe("negotiation-fabric classification", () => {
  it("still finds every fabric report prefix in the pinned SDK dist", () => {
    // isNegotiationFabric classifies SDK-minted plain Errors by message
    // prefix, and the runtime dependency is pinned to the exact audited
    // version. If an upgrade rewords a report, fail here with instructions
    // instead of regressing a healthy session's exit code silently: re-audit
    // NEGOTIATION_FABRIC_PREFIXES in src/index.ts against the new vocabulary.
    // The lifecycle tests below pin the resulting behavior.
    const sdkStdioPath = createRequire(import.meta.url).resolve("@modelcontextprotocol/server/stdio");
    const sdkSource = readFileSync(sdkStdioPath, "utf8");
    for (const prefix of NEGOTIATION_FABRIC_PREFIXES) {
      expect(sdkSource, `reworded SDK report; re-audit NEGOTIATION_FABRIC_PREFIXES: "${prefix}"`).toContain(prefix);
    }
  });
});

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
      const { child, wire } = spawnBinWire();
      // A discover round-trip proves startup finished: the signal handlers
      // are registered in the same synchronous main() body that starts
      // serving, so a reply means they are already installed. A fixed delay
      // would race slow CI.
      await wire.send(discoverRequest("2026-07-28", 1));
      expect(JSON.parse(await wire.nextMessage())).toHaveProperty("result");
      expect(await exitCodeOf(child, () => child.kill(signal))).toBe(0);
    }
  }, 30_000);

  it("terminates promptly when shutdown signals overlap", async () => {
    const { child, wire } = spawnBinWire();
    await wire.send(discoverRequest("2026-07-28", 1));
    expect(JSON.parse(await wire.nextMessage())).toHaveProperty("result");

    // Back-to-back signals: either the graceful close finishes first (exit 0)
    // or the second signal escalates to the default disposition (death by
    // signal). Both are prompt, correct terminations — which one wins is a
    // race — so the unit tests above pin the escalation semantics exactly.
    const { code, signal } = await terminationOf(child, () => {
      child.kill("SIGTERM");
      child.kill("SIGINT");
    });
    if (code === null) {
      expect(["SIGINT", "SIGTERM"]).toContain(signal);
    } else {
      expect(code).toBe(0);
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
