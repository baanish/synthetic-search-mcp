import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SyntheticSearchError, runSearchTool, searchSynthetic } from "../src/synthetic.js";
import { hangingFetch, jsonResponse, stubFetch } from "./helpers.js";

const OPTS = { apiKey: "test-key", baseUrl: "https://api.test/search" };

const sampleResult = {
  url: "https://example.com/a",
  title: "A",
  text: "body",
  published: "2026-01-01T00:00:00.000Z",
};

describe("searchSynthetic", () => {
  it("sends an authenticated POST and returns normalized results", async () => {
    const { fetchImpl, calls } = stubFetch(jsonResponse({ results: [sampleResult] }));

    const results = await searchSynthetic("hello world", { ...OPTS, fetchImpl });

    expect(results).toEqual([sampleResult]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(OPTS.baseUrl);
    const init = calls[0].init!;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ query: "hello world" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("drops invalid results and keeps valid ones", async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse({
        results: [sampleResult, { url: "https://x.com", title: "no text" }, null, "nope"],
      }),
    );

    const results = await searchSynthetic("q", { ...OPTS, fetchImpl });
    expect(results).toEqual([sampleResult]);
  });

  it("truncates result text to maxTextLength", async () => {
    const { fetchImpl } = stubFetch(jsonResponse({ results: [{ ...sampleResult, text: "z".repeat(50) }] }));
    const results = await searchSynthetic("q", { ...OPTS, fetchImpl, maxTextLength: 10 });
    expect(results[0].text).toHaveLength(10);
  });

  it("parses a body containing raw in-string control characters", async () => {
    const { fetchImpl } = stubFetch(jsonResponse('{"results":[{"url":"https://x.com","title":"t","text":"a\nb"}]}'));
    const results = await searchSynthetic("q", { ...OPTS, fetchImpl });
    expect(results[0].text).toBe("a\nb");
  });

  it("throws when results is not an array", async () => {
    const { fetchImpl } = stubFetch(jsonResponse({ results: "nope" }));
    await expect(searchSynthetic("q", { ...OPTS, fetchImpl })).rejects.toThrow(/did not include a valid results array/);
  });

  it("surfaces a JSON error body on non-2xx responses", async () => {
    const { fetchImpl } = stubFetch(jsonResponse({ error: "invalid api key" }, { status: 401 }));
    await expect(searchSynthetic("q", { ...OPTS, fetchImpl })).rejects.toThrow(
      "Synthetic API request failed with status 401: invalid api key",
    );
  });

  it("uses a generic message for an empty error body", async () => {
    const { fetchImpl } = stubFetch(new Response("", { status: 500 }));
    await expect(searchSynthetic("q", { ...OPTS, fetchImpl })).rejects.toThrow(
      "Synthetic API request failed with status 500.",
    );
  });

  it("uses the raw text for a non-JSON error body", async () => {
    const { fetchImpl } = stubFetch(new Response("Bad Gateway", { status: 502 }));
    await expect(searchSynthetic("q", { ...OPTS, fetchImpl })).rejects.toThrow(/status 502: Bad Gateway/);
  });

  it("explains a 429 rate limit and points at the quota tool", async () => {
    // Factory responder: each call gets a fresh Response (a body reads once).
    const { fetchImpl } = stubFetch(() => jsonResponse({ error: "rate limited" }, { status: 429 }));
    await expect(searchSynthetic("q", { ...OPTS, fetchImpl })).rejects.toThrow(/status 429: rate limited/);
    await expect(searchSynthetic("q", { ...OPTS, fetchImpl })).rejects.toThrow(/search_quota/);
  });

  it("includes Retry-After on a 429 when the header is present", async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse({ error: "slow down" }, { status: 429, headers: { "retry-after": "42" } }),
    );
    await expect(searchSynthetic("q", { ...OPTS, fetchImpl })).rejects.toThrow(/Retry after 42 seconds/);
  });

  it("wraps network failures with the underlying cause", async () => {
    const fetchImpl = (async () => {
      const err = new TypeError("fetch failed");
      (err as { cause?: unknown }).cause = { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND api.test" };
      throw err;
    }) as typeof fetch;
    await expect(searchSynthetic("q", { ...OPTS, fetchImpl })).rejects.toThrow(/ENOTFOUND/);
    await expect(searchSynthetic("q", { ...OPTS, fetchImpl })).rejects.toBeInstanceOf(SyntheticSearchError);
  });

  it("times out a hung request", async () => {
    const results = searchSynthetic("q", { ...OPTS, fetchImpl: hangingFetch(), timeoutMs: 25 });
    await expect(results).rejects.toThrow(/timed out after 25ms/);
  });

  it("rejects an over-large response by Content-Length", async () => {
    const { fetchImpl } = stubFetch(jsonResponse({ results: [] }, { headers: { "content-length": "999999" } }));
    await expect(searchSynthetic("q", { ...OPTS, fetchImpl, maxResponseBytes: 100 })).rejects.toThrow(/too large/);
  });

  it("throws when no API key is available", async () => {
    const saved = process.env.SYNTHETIC_API_KEY;
    delete process.env.SYNTHETIC_API_KEY;
    try {
      const { fetchImpl } = stubFetch(jsonResponse({ results: [] }));
      await expect(searchSynthetic("q", { baseUrl: OPTS.baseUrl, fetchImpl })).rejects.toThrow(
        /Missing SYNTHETIC_API_KEY/,
      );
    } finally {
      if (saved === undefined) delete process.env.SYNTHETIC_API_KEY;
      else process.env.SYNTHETIC_API_KEY = saved;
    }
  });
});

describe("runSearchTool", () => {
  it("returns the results as pretty JSON text on success", async () => {
    const { fetchImpl } = stubFetch(jsonResponse({ results: [sampleResult] }));
    const result = await runSearchTool("q", { ...OPTS, fetchImpl });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].type).toBe("text");
    expect(JSON.parse(result.content[0].text)).toEqual([sampleResult]);
  });

  it("returns an isError result with the error message on failure", async () => {
    const { fetchImpl } = stubFetch(jsonResponse({ error: "boom" }, { status: 500 }));
    const result = await runSearchTool("q", { ...OPTS, fetchImpl });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("boom");
  });

  it("wraps a non-Error fetch failure into an isError result", async () => {
    const fetchImpl = (async () => {
      throw "plain string failure";
    }) as typeof fetch;
    const result = await runSearchTool("q", { ...OPTS, fetchImpl });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("plain string failure");
  });
});

describe("API key fallback to env", () => {
  const original = process.env.SYNTHETIC_API_KEY;
  beforeEach(() => {
    process.env.SYNTHETIC_API_KEY = "env-key";
  });
  afterEach(() => {
    if (original === undefined) delete process.env.SYNTHETIC_API_KEY;
    else process.env.SYNTHETIC_API_KEY = original;
  });

  it("uses SYNTHETIC_API_KEY when no override is provided", async () => {
    const { fetchImpl, calls } = stubFetch(jsonResponse({ results: [] }));
    await searchSynthetic("q", { baseUrl: OPTS.baseUrl, fetchImpl });
    expect((calls[0].init!.headers as Record<string, string>).Authorization).toBe("Bearer env-key");
  });
});
