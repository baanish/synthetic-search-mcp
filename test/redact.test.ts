import { describe, expect, it } from "vitest";

import { formatApiError } from "../src/synthetic.js";
import { redactSecrets } from "../src/redact.js";
import { searchSynthetic } from "../src/synthetic.js";
import { jsonResponse, stubFetch } from "./helpers.js";

describe("redactSecrets", () => {
  it("replaces the active API key verbatim", () => {
    const key = "syn_secret_key_value_abcdef123456";
    expect(redactSecrets(`token was ${key}`, key)).toBe("token was [redacted]");
  });

  it("replaces Bearer tokens", () => {
    expect(redactSecrets("rejected: Bearer abc.def-ghi_jkl", "")).toBe("rejected: Bearer [redacted]");
  });

  it("replaces syn_-prefixed keys", () => {
    expect(redactSecrets("bad key syn_live_abc123", "")).toBe("bad key [redacted]");
  });
});

describe("formatApiError redaction", () => {
  it("redacts a reflected API key in a JSON error body", () => {
    const key = "syn_secret_key_value_abcdef123456";
    const body = JSON.stringify({ error: `rejected token: Bearer ${key}` });
    const message = formatApiError(401, body, key);

    expect(message).not.toContain(key);
    expect(message).toMatch(/\[redacted\]/);
  });
});

describe("searchSynthetic error redaction", () => {
  it("redacts a reflected API key before surfacing the error", async () => {
    const key = "syn_secret_key_value_abcdef123456";
    const body = JSON.stringify({ error: `rejected token: Bearer ${key}` });
    const { fetchImpl } = stubFetch(jsonResponse(body, { status: 401 }));

    await expect(
      searchSynthetic("q", { apiKey: key, baseUrl: "https://api.test/search", fetchImpl }),
    ).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(key);
      expect(message).toMatch(/\[redacted\]/);
      return true;
    });
  });
});
