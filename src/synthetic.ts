// Core Synthetic search logic, kept free of import-time side effects so it can
// be unit-tested directly and reused by the MCP server wiring in index.ts.

export const SYNTHETIC_API_URL = "https://api.synthetic.new/v2/search";

/** Maximum number of characters retained per result's extracted page text. */
export const DEFAULT_MAX_TEXT_LENGTH = 2000;

/** Per-request timeout (connect + body read) in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Largest response body (declared via Content-Length) we are willing to read.
 * A misbehaving or compromised upstream could otherwise return an arbitrarily
 * large body and stall the event loop / exhaust memory in this single-process
 * stdio server. Combined with DEFAULT_TIMEOUT_MS this bounds the practical
 * worst case; a chunked response with no Content-Length is still bounded by the
 * timeout rather than by byte count.
 */
export const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

export const SEARCH_TOOL_DESCRIPTION =
  "Search the public web with Synthetic. Use this when you need fresh web results with extracted page text for a specific query. Input only supports a single query string, and the response returns a small set of relevant results with URLs, titles, published dates, and truncated text snippets.";

export type SyntheticSearchResult = {
  url: string;
  title: string;
  text: string;
  published: string | null;
};

export type SyntheticSearchResponse = {
  results?: unknown;
};

export type SearchOptions = {
  /** API key override; falls back to SYNTHETIC_API_KEY when omitted. */
  apiKey?: string;
  /** Endpoint override (used by tests). */
  baseUrl?: string;
  /** fetch implementation override (used by tests). */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Maximum characters retained per result text. */
  maxTextLength?: number;
  /** Maximum response body size (by Content-Length) in bytes. */
  maxResponseBytes?: number;
};

/** Minimal MCP tool-result shape, kept decoupled from the SDK types. */
export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export class SyntheticSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyntheticSearchError";
  }
}

export function getApiKey(): string {
  const apiKey = process.env.SYNTHETIC_API_KEY?.trim();

  if (!apiKey) {
    throw new SyntheticSearchError(
      "Missing SYNTHETIC_API_KEY environment variable. Set it before starting synthetic-search-mcp.",
    );
  }

  return apiKey;
}

function resolveApiKey(override?: string): string {
  const fromOverride = override?.trim();
  if (fromOverride) {
    return fromOverride;
  }

  return getApiKey();
}

// Drop any unpaired high surrogate(s) left at the end of `value` after a slice
// split an astral character (emoji, etc.). A trailing high surrogate is always
// unpaired (nothing follows it), so it is removed; a complete pair ends in a low
// surrogate and is left intact. The loop also handles adversarial input with
// several consecutive lone high surrogates.
function dropDanglingHighSurrogates(value: string): string {
  let end = value.length;
  while (end > 0) {
    const code = value.charCodeAt(end - 1);
    if (code < 0xd800 || code > 0xdbff) {
      break;
    }
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

/**
 * Truncate `value` to at most `maxLength` code units, appending an ellipsis when
 * the value is shortened. The returned string never exceeds `maxLength` code
 * units, and truncation never introduces a lone trailing UTF-16 surrogate.
 */
export function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  const ellipsis = "...";

  // Not enough room for content plus an ellipsis: hard-truncate to the bound.
  if (maxLength <= ellipsis.length) {
    return dropDanglingHighSurrogates(value.slice(0, Math.max(0, maxLength)));
  }

  const cut = dropDanglingHighSurrogates(value.slice(0, maxLength - ellipsis.length));
  return `${cut}${ellipsis}`;
}

export function escapeJsonControlCharacter(charCode: number): string {
  switch (charCode) {
    case 0x08:
      return "\\b";
    case 0x09:
      return "\\t";
    case 0x0a:
      return "\\n";
    case 0x0c:
      return "\\f";
    case 0x0d:
      return "\\r";
    default:
      return `\\u${charCode.toString(16).padStart(4, "0")}`;
  }
}

/**
 * Best-effort repair of raw (unescaped) control characters that appear inside
 * JSON string values, which some upstreams emit and which `JSON.parse` rejects.
 *
 * Only in-string control characters are repaired. Control characters in
 * structural position cannot be salvaged into valid JSON and are intentionally
 * left to fail the subsequent parse (handled by the caller's try/catch).
 */
export function sanitizeJsonResponse(rawText: string): string {
  let sanitized = "";
  let inString = false;
  let isEscaping = false;

  for (const char of rawText) {
    const charCode = char.charCodeAt(0);

    if (!inString) {
      if (char === "\"") {
        inString = true;
      }

      sanitized += char;
      continue;
    }

    if (isEscaping) {
      // A backslash immediately followed by a raw control character is not a
      // valid JSON escape. We have already emitted the backslash, so escape it
      // (yielding "\\") and emit a proper escape for the control character so
      // the result stays parseable.
      if (charCode <= 0x1f) {
        sanitized += `\\${escapeJsonControlCharacter(charCode)}`;
      } else {
        sanitized += char;
      }

      isEscaping = false;
      continue;
    }

    if (char === "\\") {
      sanitized += char;
      isEscaping = true;
      continue;
    }

    if (char === "\"") {
      sanitized += char;
      inString = false;
      continue;
    }

    if (charCode <= 0x1f) {
      sanitized += escapeJsonControlCharacter(charCode);
      continue;
    }

    sanitized += char;
  }

  return sanitized;
}

export function parseSyntheticResponse(rawText: string): SyntheticSearchResponse {
  // Fast path: valid JSON parses directly with no rewriting. Only fall back to
  // the (more expensive) sanitizer when the upstream emitted malformed JSON,
  // e.g. raw control characters inside string values.
  try {
    return JSON.parse(rawText) as SyntheticSearchResponse;
  } catch {
    try {
      return JSON.parse(sanitizeJsonResponse(rawText)) as SyntheticSearchResponse;
    } catch (error) {
      throw new SyntheticSearchError(
        `Synthetic API returned malformed JSON that could not be parsed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function normalizeResult(
  rawResult: unknown,
  maxTextLength: number = DEFAULT_MAX_TEXT_LENGTH,
): SyntheticSearchResult | null {
  if (typeof rawResult !== "object" || rawResult === null) {
    return null;
  }

  const result = rawResult as Record<string, unknown>;
  const url = typeof result.url === "string" ? result.url : null;
  const title = typeof result.title === "string" ? result.title : null;
  const text = typeof result.text === "string" ? result.text : null;
  const published = typeof result.published === "string" ? result.published : null;

  // Drop results missing required fields, or whose URL is not a web (http/https)
  // URL — this keeps javascript:/data:/file: URLs from untrusted upstream
  // content out of the tool output returned to the model.
  if (!url || !title || !text || !isHttpUrl(url)) {
    return null;
  }

  return {
    url,
    title,
    text: truncateText(text, maxTextLength),
    published,
  };
}

export function formatApiError(status: number, bodyText: string): string {
  const body = bodyText.trim();

  if (!body) {
    return `Synthetic API request failed with status ${status}.`;
  }

  try {
    const parsed = parseSyntheticResponse(body) as Record<string, unknown>;
    const message =
      typeof parsed.error === "string"
        ? parsed.error
        : typeof parsed.message === "string"
          ? parsed.message
          : null;

    if (message) {
      return `Synthetic API request failed with status ${status}: ${message}`;
    }
  } catch {
    // Fall back to raw text when the error body is not valid JSON.
  }

  return `Synthetic API request failed with status ${status}: ${truncateText(body, 400)}`;
}

function describeFetchError(error: unknown): string {
  // Global fetch surfaces the underlying network reason on `error.cause`; the
  // top-level message is usually just "fetch failed".
  const cause = (error as { cause?: { code?: string; message?: string } } | undefined)?.cause;
  if (cause?.code) {
    return cause.message ? `${cause.code} (${cause.message})` : cause.code;
  }

  return error instanceof Error ? error.message : String(error);
}

export async function searchSynthetic(
  query: string,
  options: SearchOptions = {},
): Promise<SyntheticSearchResult[]> {
  const {
    baseUrl = SYNTHETIC_API_URL,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxTextLength = DEFAULT_MAX_TEXT_LENGTH,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  } = options;
  const apiKey = resolveApiKey(options.apiKey);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  let rawText: string;
  try {
    response = await fetchImpl(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });

    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
      throw new SyntheticSearchError(
        `Synthetic API response is too large (${declaredLength} bytes exceeds the ${maxResponseBytes}-byte limit).`,
      );
    }

    rawText = await response.text();
  } catch (error) {
    if (error instanceof SyntheticSearchError) {
      throw error;
    }
    if (controller.signal.aborted) {
      throw new SyntheticSearchError(`Synthetic API request timed out after ${timeoutMs}ms.`);
    }
    throw new SyntheticSearchError(`Failed to reach the Synthetic API: ${describeFetchError(error)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new SyntheticSearchError(formatApiError(response.status, rawText));
  }

  const parsed = parseSyntheticResponse(rawText);

  if (!Array.isArray(parsed.results)) {
    throw new SyntheticSearchError("Synthetic API response did not include a valid results array.");
  }

  return parsed.results
    .map((result) => normalizeResult(result, maxTextLength))
    .filter((result): result is SyntheticSearchResult => result !== null);
}

/**
 * Run the `search` tool: perform the search and shape the result (or error)
 * into an MCP tool response. Extracted from the server wiring so it can be
 * tested without a transport.
 */
export async function runSearchTool(query: string, options: SearchOptions = {}): Promise<ToolResult> {
  try {
    const results = await searchSynthetic(query, options);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(results, null, 2),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      content: [
        {
          type: "text",
          text: message,
        },
      ],
      isError: true,
    };
  }
}
