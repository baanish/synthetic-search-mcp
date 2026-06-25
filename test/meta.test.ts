import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SERVER_VERSION } from "../src/index.js";

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
) as { version: string };

describe("server metadata", () => {
  // Contract: the version the MCP server advertises must match package.json.
  // If this fails after a version bump, update SERVER_VERSION in src/index.ts
  // to match package.json (they are intentionally kept in lockstep).
  it("advertises the package.json version", () => {
    expect(SERVER_VERSION).toBe(pkg.version);
  });
});
