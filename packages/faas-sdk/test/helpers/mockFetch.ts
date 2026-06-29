/** A tiny scriptable `fetch` mock for SDK unit tests — records calls, returns scripted responses. */

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface MockResponseSpec {
  status?: number;
  body?: unknown;
  /** Raw response text, sent verbatim (e.g. an HTML gateway page). Takes precedence over `body`. */
  rawBody?: string;
  headers?: Record<string, string>;
  /** Reject the fetch with this error (simulates a network failure). */
  throwError?: Error;
  /** Never resolve until the request signal aborts (simulates a hang → timeout). */
  hang?: boolean;
  /**
   * Resolve the Response (headers) immediately but stall the BODY stream until the
   * request signal aborts — simulates a slow/stalled body the transport must read
   * inside the timeout/abort window.
   */
  hangBody?: boolean;
}

export type MockHandler = (call: RecordedCall, index: number) => MockResponseSpec;

export interface MockFetch {
  fetch: typeof fetch;
  calls: RecordedCall[];
}

/** Build a mock fetch. Pass an array (one response per call) or a handler function. */
export function mockFetch(script: MockResponseSpec[] | MockHandler): MockFetch {
  const calls: RecordedCall[] = [];
  const handler: MockHandler = Array.isArray(script)
    ? (_call, i) => script[Math.min(i, script.length - 1)] ?? { status: 200, body: {} }
    : script;

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const headerObj: Record<string, string> = {};
    if (init?.headers) {
      new Headers(init.headers).forEach((v, k) => {
        headerObj[k] = v;
      });
    }
    const call: RecordedCall = {
      url,
      method: init?.method ?? "GET",
      headers: headerObj,
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    const index = calls.length;
    calls.push(call);
    const spec = handler(call, index);

    if (spec.throwError) throw spec.throwError;

    if (spec.hang) {
      const signal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }

    if (spec.hangBody) {
      const signal = init?.signal as AbortSignal | undefined;
      // Headers resolve now; the body stream stays open until the request aborts,
      // at which point it errors — exactly what a stalled body does on the wire.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const abort = () => controller.error(new DOMException("aborted", "AbortError"));
          if (signal?.aborted) {
            abort();
            return;
          }
          signal?.addEventListener("abort", abort, { once: true });
        },
      });
      const headers = new Headers({ "content-type": "application/json", ...spec.headers });
      return new Response(stream, { status: spec.status ?? 200, headers });
    }

    const status = spec.status ?? 200;
    const bodyText = spec.rawBody !== undefined ? spec.rawBody : spec.body === undefined ? "" : JSON.stringify(spec.body);
    const defaultType = spec.rawBody !== undefined ? "text/html" : "application/json";
    const headers = new Headers({ "content-type": defaultType, ...spec.headers });
    return new Response(bodyText, { status, headers });
  }) as typeof fetch;

  return { fetch: fetchImpl, calls };
}

/** An immediate (no real delay) sleep, for deterministic retry/poll tests. */
export const immediateSleep = (_ms: number): Promise<void> => Promise.resolve();
