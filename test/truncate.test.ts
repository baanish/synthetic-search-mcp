import { describe, expect, it } from "vitest";

import { truncateText } from "../src/synthetic.js";

describe("truncateText", () => {
  it("returns the value unchanged when shorter than the limit", () => {
    expect(truncateText("hello", 10)).toBe("hello");
  });

  it("returns the value unchanged at the exact boundary", () => {
    expect(truncateText("hello", 5)).toBe("hello");
  });

  it("truncates and appends an ellipsis, never exceeding the limit", () => {
    const out = truncateText("hello world", 8);
    expect(out).toBe("hello...");
    expect(out.length).toBe(8);
  });

  // Characterization tests for the small-limit edge. Before the fix,
  // `slice(0, maxLength - 3)` used a negative index and produced output LONGER
  // than maxLength. If these values change after a refactor, that is
  // intentional — update them together with the truncateText contract.
  it.each([
    [0, ""],
    [1, "h"],
    [2, "he"],
    [3, "hel"],
    [4, "h..."],
  ])("hard-truncates within the bound for maxLength=%i", (maxLength, expected) => {
    const out = truncateText("hello world", maxLength);
    expect(out).toBe(expected);
    expect(out.length).toBeLessThanOrEqual(maxLength);
  });

  it("does not split a UTF-16 surrogate pair", () => {
    // 10 grinning-face emoji; each is 2 UTF-16 code units (length 20).
    const emoji = "\u{1F600}".repeat(10);
    const out = truncateText(emoji, 8);
    // Cut at code unit 5 would land mid-emoji; the dangling high surrogate is
    // dropped, so the output has no lone surrogate and stays within the bound.
    expect(out.endsWith("...")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(8);
    const body = out.slice(0, -3);
    const lastCode = body.charCodeAt(body.length - 1);
    expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
  });
});
