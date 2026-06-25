import { describe, expect, it } from "vitest";

import { searchSynthetic } from "../src/synthetic.js";

// Opt-in smoke test against the real Synthetic API. Runs only when a key is
// available (loaded from .env by test/setup.ts); skipped in CI.
const hasKey = Boolean(process.env.SYNTHETIC_API_KEY?.trim());

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
});
