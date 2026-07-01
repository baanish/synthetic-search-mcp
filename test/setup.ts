import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Load .env into process.env so the opt-in live test (test/live.test.ts) can run
// locally. When no .env / SYNTHETIC_API_KEY is present (e.g. in CI) the live
// test skips itself. Only assigns keys that are not already set.
if (!process.env.SYNTHETIC_API_KEY) {
  try {
    const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (match && process.env[match[1]] === undefined) {
        const raw = match[2];
        const unquoted =
          (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
            ? raw.slice(1, -1)
            : raw;
        process.env[match[1]] = unquoted;
      }
    }
  } catch {
    // No .env file present; live test will skip.
  }
}
