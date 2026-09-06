import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { type McpHttpHandler, type McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";

import { createServer } from "../src/index.js";
import { SEARCH_TOOL_DESCRIPTION } from "../src/synthetic.js";
import { jsonResponse, stubFetch } from "./helpers.js";

const sampleResult = {
  url: "https://example.com/a",
  title: "A",
  text: "body",
  published: null,
};

type Active = {
  client: Client;
  close: () => Promise<void>;
};

let active: Active | null = null;

async function closeAll(parts: { client: Client; server?: McpServer; handler?: McpHttpHandler }[]) {
  for (const { client } of parts) {
    await client.close();
  }
  for (const { server } of parts) {
    await server?.close();
  }
  for (const { handler } of parts) {
    await handler?.close();
  }
}

/** Connect a 2025-era client and server instance over an in-memory wire. */
async function connectInMemory(options = {}) {
  const server = createServer({ apiKey: "test-key", baseUrl: "https://api.test/search", ...options });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

/**
 * Connect a client to the stateless HTTP serving entry in-process: the
 * transport's fetch is routed to `handler.fetch`, so no socket is opened.
 * Omitting `clientOptions` yields a 2025-era client (no version negotiation).
 */
async function connectHandler(options = {}, clientOptions?: ConstructorParameters<typeof Client>[1]) {
  const handler = createMcpHandler(() =>
    createServer({ apiKey: "test-key", baseUrl: "https://api.test/search", ...options }),
  );
  const transport = new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client({ name: "test-client", version: "0.0.0" }, clientOptions);
  await client.connect(transport);
  return { client, handler };
}

function track(parts: Awaited<ReturnType<typeof connectInMemory | typeof connectHandler>>): Active {
  return {
    client: parts.client,
    close: () => closeAll([parts]),
  };
}

afterEach(async () => {
  await active?.close();
  active = null;
});

describe("createServer (2025-era instance)", () => {
  it("registers the search and search_quota tools with annotations", async () => {
    active = track(await connectInMemory());
    const { tools } = await active.client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual(["search", "search_quota"]);

    const search = tools.find((t) => t.name === "search")!;
    expect(search.description).toBe(SEARCH_TOOL_DESCRIPTION);
    expect(search.annotations?.readOnlyHint).toBe(true);
    expect(search.annotations?.openWorldHint).toBe(true);
    expect(search.inputSchema.required).toContain("query");

    const quota = tools.find((t) => t.name === "search_quota")!;
    expect(quota.annotations?.readOnlyHint).toBe(true);
  });

  it("returns the search quota through the search_quota tool", async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse({
        subscription: { limit: 750, requests: 10, renewsAt: "2026-07-01T00:00:00.000Z" },
        search: { hourly: { limit: 250, requests: 28, renewsAt: "2026-06-26T21:00:00.000Z" } },
      }),
    );
    active = track(await connectInMemory({ fetchImpl }));

    const result = await active.client.callTool({ name: "search_quota", arguments: {} });

    expect(result.isError).toBeFalsy();
    const content = result.content as { type: string; text: string }[];
    const quota = JSON.parse(content[0].text);
    expect(quota.hourly).toEqual({ limit: 250, requests: 28, remaining: 222, renewsAt: "2026-06-26T21:00:00.000Z" });
    expect(quota.subscription.remaining).toBe(740);
  });

  it("returns search results through the tool call", async () => {
    const { fetchImpl } = stubFetch(jsonResponse({ results: [sampleResult] }));
    active = track(await connectInMemory({ fetchImpl }));

    const result = await active.client.callTool({ name: "search", arguments: { query: "hello" } });

    expect(result.isError).toBeFalsy();
    const content = result.content as { type: string; text: string }[];
    expect(content[0].type).toBe("text");
    expect(JSON.parse(content[0].text)).toEqual([sampleResult]);
  });

  it("surfaces upstream failures as an error tool result", async () => {
    const { fetchImpl } = stubFetch(jsonResponse({ error: "nope" }, { status: 500 }));
    active = track(await connectInMemory({ fetchImpl }));

    const result = await active.client.callTool({ name: "search", arguments: { query: "hello" } });

    expect(result.isError).toBe(true);
    const content = result.content as { type: string; text: string }[];
    expect(content[0].text).toContain("nope");
  });

  it("rejects an empty query via input validation", async () => {
    active = track(await connectInMemory());
    // The SDK surfaces input-schema failures as an isError tool result.
    const result = await active.client.callTool({ name: "search", arguments: { query: "   " } });
    expect(result.isError).toBe(true);
    const content = result.content as { type: string; text: string }[];
    expect(content[0].text).toContain("Input validation error");
    // Pin the project's own constraint (.trim().min(1, "Query is required.")),
    // not just the generic SDK envelope.
    expect(content[0].text).toContain("Query is required.");
  });
});

describe("stateless protocol (2026-07-28)", () => {
  it("negotiates the modern era via server/discover and lists tools", async () => {
    active = track(await connectHandler({}, { versionNegotiation: { mode: "auto" } }));

    expect(active.client.getProtocolEra()).toBe("modern");

    const { tools } = await active.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["search", "search_quota"]);
    const search = tools.find((t) => t.name === "search")!;
    expect(search.description).toBe(SEARCH_TOOL_DESCRIPTION);
  });

  it("returns search results over per-request stateless serving", async () => {
    const { fetchImpl } = stubFetch(jsonResponse({ results: [sampleResult] }));
    active = track(await connectHandler({ fetchImpl }, { versionNegotiation: { mode: "auto" } }));

    const result = await active.client.callTool({ name: "search", arguments: { query: "hello" } });

    expect(result.isError).toBeFalsy();
    const content = result.content as { type: string; text: string }[];
    expect(JSON.parse(content[0].text)).toEqual([sampleResult]);
  });

  it("rejects an empty query via input validation", async () => {
    active = track(await connectHandler({}, { versionNegotiation: { mode: "auto" } }));

    const result = await active.client.callTool({ name: "search", arguments: { query: "   " } });

    expect(result.isError).toBe(true);
    const content = result.content as { type: string; text: string }[];
    expect(content[0].text).toContain("Input validation error");
    expect(content[0].text).toContain("Query is required.");
  });
});

describe("legacy client compatibility (same handler)", () => {
  it("serves a 2025-era handshake client from the same factory", async () => {
    const { fetchImpl } = stubFetch(jsonResponse({ results: [sampleResult] }));
    // No versionNegotiation: the client opens with the 2025 initialize handshake.
    active = track(await connectHandler({ fetchImpl }));

    expect(active.client.getProtocolEra()).toBe("legacy");

    const { tools } = await active.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["search", "search_quota"]);

    const result = await active.client.callTool({ name: "search", arguments: { query: "hello" } });
    expect(result.isError).toBeFalsy();
    const content = result.content as { type: string; text: string }[];
    expect(JSON.parse(content[0].text)).toEqual([sampleResult]);
  });
});
