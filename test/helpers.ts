// Shared test utilities: response builders, a fetch stub, and a seeded PRNG so
// fuzz failures are reproducible.

export type FetchCall = { url: string; init: RequestInit | undefined };

/** Build a `fetch` stub that returns the given response(s) and records calls. */
export function stubFetch(
  responder: Response | ((url: string, init: RequestInit | undefined) => Response | Promise<Response>),
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return typeof responder === "function" ? responder(String(input), init) : responder;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

export function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

/** A fetch stub that never resolves until its signal aborts, then rejects. */
export function hangingFetch(): typeof fetch {
  return ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal) {
        signal.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      }
    })) as typeof fetch;
}

/** Deterministic PRNG (mulberry32) for reproducible fuzzing. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
