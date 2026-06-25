import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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

async function connect(options = {}) {
  const server = createServer({ apiKey: "test-key", baseUrl: "https://api.test/search", ...options });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

let active: { client: Client; server: Awaited<ReturnType<typeof createServer>> } | null = null;

afterEach(async () => {
  await active?.client.close();
  await active?.server.close();
  active = null;
});

describe("createServer", () => {
  it("registers the search tool with description and annotations", async () => {
    active = await connect();
    const { tools } = await active.client.listTools();

    expect(tools).toHaveLength(1);
    const tool = tools[0];
    expect(tool.name).toBe("search");
    expect(tool.description).toBe(SEARCH_TOOL_DESCRIPTION);
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tool.annotations?.openWorldHint).toBe(true);
    expect(tool.inputSchema.required).toContain("query");
  });

  it("returns search results through the tool call", async () => {
    const { fetchImpl } = stubFetch(jsonResponse({ results: [sampleResult] }));
    active = await connect({ fetchImpl });

    const result = await active.client.callTool({ name: "search", arguments: { query: "hello" } });

    expect(result.isError).toBeFalsy();
    const content = result.content as { type: string; text: string }[];
    expect(content[0].type).toBe("text");
    expect(JSON.parse(content[0].text)).toEqual([sampleResult]);
  });

  it("surfaces upstream failures as an error tool result", async () => {
    const { fetchImpl } = stubFetch(jsonResponse({ error: "nope" }, { status: 500 }));
    active = await connect({ fetchImpl });

    const result = await active.client.callTool({ name: "search", arguments: { query: "hello" } });

    expect(result.isError).toBe(true);
    const content = result.content as { type: string; text: string }[];
    expect(content[0].text).toContain("nope");
  });

  it("rejects an empty query via input validation", async () => {
    active = await connect();
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
