import { describe, expect, it } from "vitest";

import { formatApiError, runSearchTool, searchSynthetic } from "../src/synthetic.js";
import { redactSecrets } from "../src/redact.js";
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

describe("runSearchTool error redaction (tool-boundary backstop)", () => {
  it("redacts key material echoed via a JSON.parse error on a malformed 2xx body", async () => {
    const key = "syn_secret_key_value_abcdef123456";
    // A 200 body that is not valid JSON and begins with key material. JSON.parse's
    // error message echoes a short prefix of the body (which parseSyntheticResponse
    // surfaces unredacted); the tool boundary must redact it before MCP output.
    const { fetchImpl } = stubFetch(() => new Response(`${key} not valid json`, { status: 200 }));

    const result = await runSearchTool("q", { apiKey: key, baseUrl: "https://api.test/search", fetchImpl });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain("syn_secret");
    expect(result.content[0].text).toContain("[redacted]");
  });
});
