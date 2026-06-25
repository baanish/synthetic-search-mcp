import { describe, expect, it } from "vitest";

import {
  SyntheticSearchError,
  normalizeResult,
  parseSyntheticResponse,
  searchSynthetic,
  truncateText,
} from "../src/synthetic.js";
import { jsonResponse, mulberry32, stubFetch } from "./helpers.js";

const ITERATIONS = 3000;

// A grab-bag of characters that stress the JSON sanitizer / parser:
// structural tokens, escapes, control chars, surrogate halves, and astral chars.
function randomString(rand: () => number, maxLen: number): string {
  const len = Math.floor(rand() * maxLen);
  let out = "";
  for (let i = 0; i < len; i++) {
    const pick = rand();
    if (pick < 0.3) {
      out += '"\\{}[]:,'[Math.floor(rand() * 8)];
    } else if (pick < 0.5) {
      out += String.fromCharCode(Math.floor(rand() * 0x20)); // control chars
    } else if (pick < 0.72) {
      out += String.fromCharCode(0x20 + Math.floor(rand() * 0x5f)); // printable ASCII
    } else if (pick < 0.86) {
      out += String.fromCharCode(0xd800 + Math.floor(rand() * 0x400)); // lone high surrogate
    } else {
      out += String.fromCodePoint(0x1f300 + Math.floor(rand() * 0x300)); // astral
    }
  }
  return out;
}

// Printable-ASCII + raw control chars only (no quotes/backslashes), so a value
// JSON.stringify-escapes into nothing but control-char escapes — letting us
// unescape them back to raw control chars to forge malformed-but-repairable JSON.
function controlHeavyString(rand: () => number, maxLen: number): string {
  const len = Math.floor(rand() * maxLen);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += rand() < 0.5 ? String.fromCharCode(Math.floor(rand() * 0x20)) : String.fromCharCode(0x61 + Math.floor(rand() * 26));
  }
  return out;
}

const URL_POOL = [
  "https://example.com/a",
  "http://example.org/b?q=1",
  "https://news.example.com/x#y",
  "javascript:alert(1)",
  "data:text/html,<i>",
  "file:///etc/passwd",
  "ftp://host/x",
  "not a url",
  "",
];

// Generate a result-shaped object whose fields are sometimes valid, sometimes
// missing, sometimes the wrong type — so normalizeResult exercises both its
// accept and reject branches.
function randomResult(rand: () => number): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  if (rand() < 0.85) obj.url = URL_POOL[Math.floor(rand() * URL_POOL.length)];
  else if (rand() < 0.5) obj.url = 123;
  if (rand() < 0.85) obj.title = randomString(rand, 10);
  else if (rand() < 0.5) obj.title = null;
  if (rand() < 0.85) obj.text = randomString(rand, 60);
  else if (rand() < 0.5) obj.text = 42;
  const p = rand();
  if (p < 0.5) obj.published = "2026-01-01T00:00:00.000Z";
  else if (p < 0.7) obj.published = 99;
  return obj;
}

function randomJsonValue(rand: () => number, depth: number): unknown {
  const pick = rand();
  if (depth <= 0 || pick < 0.45) {
    const leaf = rand();
    if (leaf < 0.3) return randomString(rand, 12);
    if (leaf < 0.55) return Math.floor(rand() * 2000) - 1000;
    if (leaf < 0.75) return rand() < 0.5;
    return null;
  }
  const size = Math.floor(rand() * 4);
  if (pick < 0.72) {
    return Array.from({ length: size }, () => randomJsonValue(rand, depth - 1));
  }
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < size; i++) {
    obj[`k${i}`] = randomJsonValue(rand, depth - 1);
  }
  return obj;
}

describe("fuzz: parseSyntheticResponse", () => {
  it("only ever throws SyntheticSearchError on arbitrary input", () => {
    const rand = mulberry32(0xc0ffee);
    for (let i = 0; i < ITERATIONS; i++) {
      const input = randomString(rand, 80);
      try {
        parseSyntheticResponse(input);
      } catch (error) {
        if (!(error instanceof SyntheticSearchError)) {
          throw new Error(`Unexpected error for input ${JSON.stringify(input)}: ${String(error)}`);
        }
      }
    }
  });

  it("repairs raw in-string control characters back to the original value", () => {
    const rand = mulberry32(0x1234abcd);
    let repaired = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      const value = {
        a: controlHeavyString(rand, 40),
        b: controlHeavyString(rand, 20),
        nested: { c: controlHeavyString(rand, 15) },
      };
      const serialized = JSON.stringify(value);
      // Turn the control-char escapes back into raw control chars: this is the
      // malformed-but-repairable JSON the sanitizer fallback exists to fix. The
      // values contain no quotes/backslashes, so these are the only escapes.
      const malformed = serialized
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\r/g, "\r")
        .replace(/\\b/g, "\b")
        .replace(/\\f/g, "\f")
        .replace(/\\u00([0-9a-f]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
      if (malformed !== serialized) repaired += 1;
      expect(parseSyntheticResponse(malformed)).toEqual(value);
    }
    // The point of the test is the repair path; make sure we actually hit it.
    expect(repaired).toBeGreaterThan(ITERATIONS / 2);
  });
});

describe("fuzz: truncateText", () => {
  it("never exceeds the bound and never leaves a dangling high surrogate", () => {
    const rand = mulberry32(0x5eed);
    for (let i = 0; i < ITERATIONS; i++) {
      const value = randomString(rand, 64);
      const maxLength = Math.floor(rand() * 48);
      const out = truncateText(value, maxLength);

      expect(out.length).toBeLessThanOrEqual(maxLength);
      if (value.length <= maxLength) {
        expect(out).toBe(value);
        continue;
      }
      // Truncation happened (ellipsis branch or hard-truncate branch): the
      // result must never end in a lone high surrogate.
      const body = out.endsWith("...") ? out.slice(0, -3) : out;
      if (body.length > 0) {
        const last = body.charCodeAt(body.length - 1);
        expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      }
    }
  });
});

describe("fuzz: normalizeResult", () => {
  it("never throws, and accepts/rejects result-shaped input correctly", () => {
    const rand = mulberry32(0xbeef);
    let accepted = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      const candidate = rand() < 0.85 ? randomResult(rand) : randomJsonValue(rand, 3);
      const maxTextLength = 1 + Math.floor(rand() * 30);
      const result = normalizeResult(candidate, maxTextLength);
      if (result !== null) {
        accepted += 1;
        expect(result.text.length).toBeLessThanOrEqual(maxTextLength);
        expect(["http:", "https:"]).toContain(new URL(result.url).protocol);
        expect(typeof result.title).toBe("string");
      }
    }
    // The accept-branch invariants must actually run on many iterations.
    expect(accepted).toBeGreaterThan(100);
  });
});

describe("fuzz: searchSynthetic", () => {
  it("returns well-formed results for valid envelopes and only SyntheticSearchError otherwise", async () => {
    const rand = mulberry32(0xfeedface);
    let succeeded = 0;
    let failed = 0;
    for (let i = 0; i < 400; i++) {
      const valid = rand() < 0.5;
      const body = valid
        ? JSON.stringify({ results: Array.from({ length: Math.floor(rand() * 4) }, () => randomResult(rand)) })
        : randomString(rand, 120);
      const status = valid ? 200 : rand() < 0.5 ? 200 : 400 + Math.floor(rand() * 100);
      const { fetchImpl } = stubFetch(jsonResponse(body, { status }));
      try {
        const results = await searchSynthetic("q", { apiKey: "k", baseUrl: "https://api.test", fetchImpl });
        succeeded += 1;
        expect(Array.isArray(results)).toBe(true);
        for (const result of results) {
          expect(["http:", "https:"]).toContain(new URL(result.url).protocol);
          expect(result.text.length).toBeLessThanOrEqual(2000);
        }
      } catch (error) {
        failed += 1;
        if (!(error instanceof SyntheticSearchError)) {
          throw new Error(`Unexpected error for body ${JSON.stringify(body)}: ${String(error)}`);
        }
      }
    }
    // Both the success and failure paths must be exercised.
    expect(succeeded).toBeGreaterThan(0);
    expect(failed).toBeGreaterThan(0);
  });
});
