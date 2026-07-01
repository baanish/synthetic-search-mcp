import { describe, expect, it } from "vitest";

import { SyntheticSearchError, fetchSearchQuota, normalizeQuota, runQuotaTool } from "../src/synthetic.js";
import { jsonResponse, stubFetch } from "./helpers.js";

const OPTS = { apiKey: "test-key", quotasUrl: "https://api.test/quotas" };

const livePayload = {
  subscription: { limit: 750, requests: 10, renewsAt: "2026-07-01T00:00:00.000Z" },
  search: { hourly: { limit: 250, requests: 28, renewsAt: "2026-06-26T21:00:00.000Z" } },
  freeToolCalls: { limit: 0, requests: 0, renewsAt: "2026-06-26T20:00:00.000Z" },
};

describe("normalizeQuota", () => {
  it("extracts the hourly search and subscription windows with derived remaining", () => {
    expect(normalizeQuota(livePayload)).toEqual({
      hourly: { limit: 250, requests: 28, remaining: 222, renewsAt: "2026-06-26T21:00:00.000Z" },
      subscription: { limit: 750, requests: 10, remaining: 740, renewsAt: "2026-07-01T00:00:00.000Z" },
    });
  });

  it("clamps remaining at zero when usage exceeds the limit", () => {
    expect(normalizeQuota({ search: { hourly: { limit: 250, requests: 300, renewsAt: null } } }).hourly).toEqual({
      limit: 250,
      requests: 300,
      remaining: 0,
      renewsAt: null,
    });
  });

  it.each([
    {},
    { search: {} },
    { search: { hourly: null } },
    { search: { hourly: { limit: 5 } } },
    { search: { hourly: { requests: 5 } } },
    { search: { hourly: { limit: "5", requests: 1 } } },
    null,
    "nope",
    42,
  ])("returns null windows for missing/malformed input %#", (input) => {
    const quota = normalizeQuota(input);
    expect(quota.hourly).toBeNull();
  });

  it("treats a non-string renewsAt as null", () => {
    expect(normalizeQuota({ search: { hourly: { limit: 1, requests: 0, renewsAt: 123 } } }).hourly?.renewsAt).toBeNull();
  });

  // Contract: a window's numbers must be finite. `1e999` is valid JSON that
  // JSON.parse turns into Infinity; NaN/Infinity must collapse the window to
  // null rather than surface as `null`/0 and corrupt the remaining math. If
  // this changes, update normalizeQuotaWindow and the QuotaWindow doc together.
  it("rejects non-finite numbers (1e999 -> Infinity, NaN) by nulling the window", () => {
    const fromJson = normalizeQuota(JSON.parse('{"search":{"hourly":{"limit":1e999,"requests":5,"renewsAt":null}}}'));
    expect(fromJson.hourly).toBeNull();
    expect(normalizeQuota({ subscription: { limit: 750, requests: Infinity, renewsAt: null } }).subscription).toBeNull();
    expect(normalizeQuota({ subscription: { limit: NaN, requests: 0, renewsAt: null } }).subscription).toBeNull();
  });
});

describe("fetchSearchQuota", () => {
  it("issues an authenticated GET with no body and returns the parsed quota", async () => {
    const { fetchImpl, calls } = stubFetch(jsonResponse(livePayload));

    const quota = await fetchSearchQuota({ ...OPTS, fetchImpl });

    expect(quota.hourly?.remaining).toBe(222);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(OPTS.quotasUrl);
    const init = calls[0].init!;
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    // GET has no JSON body, so no Content-Type should be sent.
    expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });

  it("throws on a non-2xx quotas response", async () => {
    const { fetchImpl } = stubFetch(jsonResponse({ error: "unauthorized" }, { status: 401 }));
    await expect(fetchSearchQuota({ ...OPTS, fetchImpl })).rejects.toThrow(/status 401: unauthorized/);
  });
});

describe("runQuotaTool", () => {
  it("returns the quota as pretty JSON on success", async () => {
    const { fetchImpl } = stubFetch(jsonResponse(livePayload));
    const result = await runQuotaTool({ ...OPTS, fetchImpl });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text).hourly.remaining).toBe(222);
  });

  it("returns an isError result on failure", async () => {
    const { fetchImpl } = stubFetch(jsonResponse({ error: "boom" }, { status: 500 }));
    const result = await runQuotaTool({ ...OPTS, fetchImpl });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("boom");
    expect(result.content[0].text).not.toContain("test-key");
  });

  it("propagates SyntheticSearchError type from the underlying fetch", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(fetchSearchQuota({ ...OPTS, fetchImpl })).rejects.toBeInstanceOf(SyntheticSearchError);
  });
});
