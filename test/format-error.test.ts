import { describe, expect, it } from "vitest";

import { formatApiError } from "../src/synthetic.js";

describe("formatApiError", () => {
  it("uses a generic message when the body is empty", () => {
    expect(formatApiError(500, "")).toBe("Synthetic API request failed with status 500.");
    expect(formatApiError(500, "   ")).toBe("Synthetic API request failed with status 500.");
  });

  it("extracts the `error` field from a JSON body", () => {
    expect(formatApiError(401, '{"error":"invalid api key"}')).toBe(
      "Synthetic API request failed with status 401: invalid api key",
    );
  });

  it("falls back to the `message` field", () => {
    expect(formatApiError(429, '{"message":"rate limited"}')).toBe(
      "Synthetic API request failed with status 429: rate limited",
    );
  });

  it("uses the raw body when JSON has neither error nor message", () => {
    expect(formatApiError(400, '{"foo":"bar"}')).toBe(
      'Synthetic API request failed with status 400: {"foo":"bar"}',
    );
  });

  it("uses the raw body when it is not JSON", () => {
    expect(formatApiError(502, "Bad Gateway")).toBe(
      "Synthetic API request failed with status 502: Bad Gateway",
    );
  });

  it("truncates a long raw body to keep the message bounded", () => {
    const message = formatApiError(500, "y".repeat(1000));
    expect(message.startsWith("Synthetic API request failed with status 500: ")).toBe(true);
    // 400-char body bound: 397 chars + the 3-char ellipsis.
    expect(message.endsWith("...")).toBe(true);
    expect(message).toContain("y".repeat(397));
  });
});
