import { describe, expect, it } from "vitest";

import {
  SyntheticSearchError,
  escapeJsonControlCharacter,
  parseSyntheticResponse,
  sanitizeJsonResponse,
} from "../src/synthetic.js";

describe("escapeJsonControlCharacter", () => {
  it.each([
    [0x08, "\\b"],
    [0x09, "\\t"],
    [0x0a, "\\n"],
    [0x0c, "\\f"],
    [0x0d, "\\r"],
  ])("maps named control char 0x%s", (code, expected) => {
    expect(escapeJsonControlCharacter(code)).toBe(expected);
  });

  it("emits a 4-hex-digit \\u escape for other control chars", () => {
    expect(escapeJsonControlCharacter(0x01)).toBe("\\u0001");
    expect(escapeJsonControlCharacter(0x1f)).toBe("\\u001f");
  });
});

describe("sanitizeJsonResponse", () => {
  it("leaves plain ASCII JSON untouched", () => {
    const input = '{"a":"b","c":1}';
    expect(sanitizeJsonResponse(input)).toBe(input);
  });

  it("escapes a raw newline inside a string so it parses", () => {
    const raw = '{"text":"line1\nline2"}';
    const sanitized = sanitizeJsonResponse(raw);
    expect(sanitized).toBe('{"text":"line1\\nline2"}');
    expect(JSON.parse(sanitized)).toEqual({ text: "line1\nline2" });
  });

  it("does not let an escaped quote close the string", () => {
    const raw = '{"text":"a \\" b\tc"}';
    const sanitized = sanitizeJsonResponse(raw);
    expect(JSON.parse(sanitized)).toEqual({ text: 'a " b\tc' });
  });

  // Regression: a backslash immediately followed by a raw control character used
  // to be copied through verbatim, leaving invalid JSON (\<newline>). It must
  // now be repaired into parseable JSON.
  it("repairs a backslash followed by a raw control character", () => {
    const raw = '{"text":"path C:\\\n more"}';
    const sanitized = sanitizeJsonResponse(raw);
    expect(() => JSON.parse(sanitized)).not.toThrow();
    expect(JSON.parse(sanitized)).toEqual({ text: "path C:\\\n more" });
  });

  it("passes already-valid escapes through unchanged", () => {
    const input = '{"text":"a \\" b \\\\ c \\n d \\u0041"}';
    expect(sanitizeJsonResponse(input)).toBe(input);
    expect(JSON.parse(sanitizeJsonResponse(input))).toEqual({ text: 'a " b \\ c \n d A' });
  });

  it("passes astral characters through untouched", () => {
    const input = '{"text":"emoji \u{1F600} ok"}';
    expect(JSON.parse(sanitizeJsonResponse(input))).toEqual({ text: "emoji \u{1F600} ok" });
  });
});

describe("parseSyntheticResponse", () => {
  it("parses valid JSON directly", () => {
    expect(parseSyntheticResponse('{"results":[]}')).toEqual({ results: [] });
  });

  it("parses JSON containing raw in-string control characters via the sanitizer", () => {
    const raw = '{"results":[{"text":"a\nb"}]}';
    expect(parseSyntheticResponse(raw)).toEqual({ results: [{ text: "a\nb" }] });
  });

  it("throws SyntheticSearchError on unrepairable malformed JSON", () => {
    expect(() => parseSyntheticResponse("{not json")).toThrow(SyntheticSearchError);
    expect(() => parseSyntheticResponse("{not json")).toThrow(/malformed JSON/);
  });
});
