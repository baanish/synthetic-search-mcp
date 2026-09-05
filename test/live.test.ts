import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { fetchSearchQuota, searchSynthetic } from "../src/synthetic.js";

const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

// Opt-in smoke test against the real Synthetic API. Runs only when a key is
// available (loaded from .env by test/setup.ts); skipped in CI.
const hasKey = Boolean(process.env.SYNTHETIC_API_KEY?.trim());

/** Connect a live MCP client to the built bin, pinned to the given era. */
async function connectLiveMcpClient(era: "modern" | "legacy"): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin],
    env: { ...process.env } as Record<string, string>,
    stderr: "ignore",
  });
  const options =
    era === "modern" ? { versionNegotiation: { mode: "auto" as const } } : undefined;
  const liveClient = new Client({ name: "live-mcp-test", version: "0.0.0" }, options);
  await liveClient.connect(transport);
  return liveClient;
}

describe.skipIf(!hasKey)("live Synthetic API", () => {
  it("returns well-formed results for a real query", async () => {
    const results = await searchSynthetic("model context protocol", { timeoutMs: 20_000 });

    expect(Array.isArray(results)).toBe(true);
    // Fail loudly instead of passing vacuously if the API returns nothing.
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(typeof result.url).toBe("string");
      expect(["http:", "https:"]).toContain(new URL(result.url).protocol);
      expect(typeof result.title).toBe("string");
      expect(typeof result.text).toBe("string");
      expect(result.text.length).toBeLessThanOrEqual(2000);
      if (result.published !== null) {
        expect(Number.isNaN(Date.parse(result.published))).toBe(false);
      }
    }
  }, 30_000);

  // Checking the quota does not count against the search quota.
  it("reports the hourly search quota", async () => {
    const quota = await fetchSearchQuota({ timeoutMs: 20_000 });

    expect(quota.hourly).not.toBeNull();
    expect(quota.hourly!.limit).toBeGreaterThan(0);
    expect(quota.hourly!.remaining).toBeLessThanOrEqual(quota.hourly!.limit);
    expect(quota.hourly!.remaining).toBeGreaterThanOrEqual(0);
    if (quota.hourly!.renewsAt !== null) {
      expect(Number.isNaN(Date.parse(quota.hourly!.renewsAt))).toBe(false);
    }
  }, 30_000);

  // End-to-end through the real shipped entry: the MCP client, the stdio
  // transport, era negotiation, and tool dispatch, against the live API.
  it.each(["modern", "legacy"] as const)(
    "serves a real search over the stdio MCP entry (%s era)",
    async (era) => {
      const liveClient = await connectLiveMcpClient(era);
      try {
        expect(liveClient.getProtocolEra()).toBe(era);

        const result = await liveClient.callTool({ name: "search", arguments: { query: "model context protocol" } });

        expect(result.isError).toBeFalsy();
        const content = result.content as { type: string; text: string }[];
        const results = JSON.parse(content[0].text) as unknown[];
        expect(Array.isArray(results)).toBe(true);
        expect(results.length).toBeGreaterThan(0);
      } finally {
        await liveClient.close();
      }
    },
    30_000,
  );

  it("serves a real search_quota over the stdio MCP entry (modern era)", async () => {
    const liveClient = await connectLiveMcpClient("modern");
    try {
      expect(liveClient.getProtocolEra()).toBe("modern");

      const result = await liveClient.callTool({ name: "search_quota", arguments: {} });

      expect(result.isError).toBeFalsy();
      const content = result.content as { type: string; text: string }[];
      const quota = JSON.parse(content[0].text) as {
        hourly: { limit: number; remaining: number } | null;
      };
      expect(quota.hourly).not.toBeNull();
      expect(quota.hourly!.limit).toBeGreaterThan(0);
      expect(quota.hourly!.remaining).toBeGreaterThanOrEqual(0);
      expect(quota.hourly!.remaining).toBeLessThanOrEqual(quota.hourly!.limit);
    } finally {
      await liveClient.close();
    }
  }, 30_000);
});
