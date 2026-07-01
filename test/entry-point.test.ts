import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { isMainModule } from "../src/index.js";

// Real temp dir (resolve so macOS /var -> /private/var symlinks don't skew the
// realpath comparison under test).
const dir = realpathSync(mkdtempSync(join(tmpdir(), "ssm-entry-")));
const real = join(dir, "index.js");
const other = join(dir, "other.js");
const link = join(dir, "bin-symlink");
writeFileSync(real, "");
writeFileSync(other, "");
symlinkSync(real, link);

const url = pathToFileURL(real).href;

afterAll(() => {
  // Temp files live under the OS temp dir; no explicit cleanup needed.
});

describe("isMainModule", () => {
  it("is true when invoked by its own real path", () => {
    expect(isMainModule(url, real)).toBe(true);
  });

  // Regression: npm/npx invoke the bin through a node_modules/.bin symlink.
  it("is true when invoked via a symlink (npx / global bin)", () => {
    expect(isMainModule(url, link)).toBe(true);
  });

  it("is false when invoked for a different module", () => {
    expect(isMainModule(url, other)).toBe(false);
  });

  it("is false when there is no invoked path (imported as a module)", () => {
    expect(isMainModule(url, undefined)).toBe(false);
  });

  it("is false (does not throw) when the invoked path does not exist", () => {
    expect(isMainModule(url, join(dir, "missing.js"))).toBe(false);
  });
});
