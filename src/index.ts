#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const SYNTHETIC_API_URL = "https://api.synthetic.new/v2/search";
const MAX_TEXT_LENGTH = 2000;

type SyntheticSearchResult = {
  url: string;
  title: string;
  text: string;
  published: string | null;
};

type SyntheticSearchResponse = {
  results?: unknown;
};

class SyntheticSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyntheticSearchError";
  }
}

function getApiKey(): string {
  const apiKey = process.env.SYNTHETIC_API_KEY?.trim();

  if (!apiKey) {
    throw new SyntheticSearchError(
      "Missing SYNTHETIC_API_KEY environment variable. Set it before starting synthetic-search-mcp.",
    );
  }

  return apiKey;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function escapeJsonControlCharacter(charCode: number): string {
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

function sanitizeJsonResponse(rawText: string): string {
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
      sanitized += char;
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

function parseSyntheticResponse(rawText: string): SyntheticSearchResponse {
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

function normalizeResult(rawResult: unknown): SyntheticSearchResult | null {
  if (typeof rawResult !== "object" || rawResult === null) {
    return null;
  }

  const result = rawResult as Record<string, unknown>;
  const url = typeof result.url === "string" ? result.url : null;
  const title = typeof result.title === "string" ? result.title : null;
  const text = typeof result.text === "string" ? result.text : null;
  const published = typeof result.published === "string" ? result.published : null;

  if (!url || !title || !text) {
    return null;
  }

  return {
    url,
    title,
    text: truncateText(text, MAX_TEXT_LENGTH),
    published,
  };
}

function formatApiError(status: number, bodyText: string): string {
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

async function searchSynthetic(query: string): Promise<SyntheticSearchResult[]> {
  const response = await fetch(SYNTHETIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify({ query }),
  });

  const rawText = await response.text();

  if (!response.ok) {
    throw new SyntheticSearchError(formatApiError(response.status, rawText));
  }

  const parsed = parseSyntheticResponse(rawText);

  if (!Array.isArray(parsed.results)) {
    throw new SyntheticSearchError("Synthetic API response did not include a valid results array.");
  }

  return parsed.results
    .map((result) => normalizeResult(result))
    .filter((result): result is SyntheticSearchResult => result !== null);
}

const server = new McpServer({
  name: "synthetic-search-mcp",
  version: "1.0.0",
});

server.tool(
  "search",
  "Search the public web with Synthetic. Use this when you need fresh web results with extracted page text for a specific query. Input only supports a single query string, and the response returns a small set of relevant results with URLs, titles, published dates, and truncated text snippets.",
  {
    query: z
      .string()
      .trim()
      .min(1, "Query is required.")
      .describe("The exact web search query to run."),
  },
  async ({ query }) => {
    try {
      const results = await searchSynthetic(query);

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
  },
);

async function main(): Promise<void> {
  if (!process.env.SYNTHETIC_API_KEY?.trim()) {
    console.error(
      "synthetic-search-mcp: SYNTHETIC_API_KEY is not set. The server will start, but search calls will fail until the variable is configured.",
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(
    `synthetic-search-mcp failed to start: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exit(1);
});
