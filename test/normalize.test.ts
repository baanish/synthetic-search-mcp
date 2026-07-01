import { describe, expect, it } from "vitest";

import { normalizeResult } from "../src/synthetic.js";

const valid = {
  url: "https://example.com/article",
  title: "Example",
  text: "Body text",
  published: "2026-03-12T10:15:00.000Z",
};

describe("normalizeResult", () => {
  it("returns a normalized result for a valid entry", () => {
    expect(normalizeResult(valid)).toEqual(valid);
  });

  it.each([null, undefined, 42, "string", []])("returns null for non-object input %s", (input) => {
    expect(normalizeResult(input)).toBeNull();
  });

  it.each(["url", "title", "text"])("returns null when required field %s is missing", (field) => {
    const partial: Record<string, unknown> = { ...valid };
    delete partial[field];
    expect(normalizeResult(partial)).toBeNull();
  });

  it.each(["url", "title", "text"])("returns null when required field %s is not a string", (field) => {
    expect(normalizeResult({ ...valid, [field]: 123 })).toBeNull();
  });

  it("sets published to null when missing or non-string", () => {
    const { published: _omit, ...withoutPublished } = valid;
    expect(normalizeResult(withoutPublished)?.published).toBeNull();
    expect(normalizeResult({ ...valid, published: 123 })?.published).toBeNull();
  });

  it("truncates text to the provided max length", () => {
    const long = { ...valid, text: "x".repeat(100) };
    const out = normalizeResult(long, 10);
    expect(out?.text.length).toBe(10);
    expect(out?.text.endsWith("...")).toBe(true);
  });

  it.each(["javascript:alert(1)", "data:text/html,<script>", "file:///etc/passwd", "ftp://host/x", "not a url"])(
    "drops results whose url is not http(s): %s",
    (url) => {
      expect(normalizeResult({ ...valid, url })).toBeNull();
    },
  );

  it("accepts plain http URLs", () => {
    expect(normalizeResult({ ...valid, url: "http://example.com" })?.url).toBe("http://example.com");
  });
});
