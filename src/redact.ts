/**
 * Upstream error bodies are echoed into user-facing errors (and thus into stdio /
 * MCP tool output). A hostile or misconfigured upstream/proxy could reflect the
 * bearer credential back; strip the active key and bearer-token-like material
 * before it is ever displayed or logged.
 *
 * Ported from synthetic-search-cli (src/lib/client.ts).
 */
export function redactSecrets(text: string, apiKey: string): string {
  let redacted = apiKey ? text.split(apiKey).join("[redacted]") : text;

  redacted = redacted
    .replace(/Bearer\s+[\w.\-~+/]+=*/gi, "Bearer [redacted]")
    .replace(/\bsyn_[\w.\-]+/g, "[redacted]");

  return redacted;
}
