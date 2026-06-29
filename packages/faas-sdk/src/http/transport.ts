/**
 * The HTTP transport: URL building, auth/idempotency headers, timeout, a bounded
 * response read, JSON parsing, and the retry loop.
 *
 * Conventions: trailing-slash strip, AbortController timeout, bounded read,
 * `X-Api-Key` + `Idempotency-Key` headers, and the key is NEVER placed into any
 * logged/intercepted object.
 */

import { MyStarsApiError, NetworkError, TimeoutError, errorFromResponse } from "../errors.js";
import { defaultSleep } from "../internal/sleep.js";
import { type RetryContext, type ResolvedRetryPolicy, computeDelayMs } from "./retry.js";

/** Max bytes read from a response body before bailing (DoS guard). */
const MAX_RESPONSE_BYTES = 4_000_000;

/** Info passed to {@link Interceptors.onRequest} before an attempt is sent. Never contains the API key. */
export interface RequestLogInfo {
  method: string;
  url: string;
  idempotencyKey?: string;
}
/** Info passed to {@link Interceptors.onResponse} after a response is received. */
export interface ResponseLogInfo {
  method: string;
  url: string;
  status: number;
  /** Wall-clock duration of the attempt, in ms. */
  durationMs: number;
  requestId?: string;
}
/** Info passed to {@link Interceptors.onRetry} just before the SDK sleeps and retries. */
export interface RetryLogInfo {
  method: string;
  url: string;
  /** 1-based index of the retry about to be made. */
  attempt: number;
  /** Backoff the SDK will wait before the retry, in ms. */
  delayMs: number;
  /** Why the retry fired, e.g. `"timeout (HTTP 0)"`. */
  reason: string;
}

/**
 * Observability hooks invoked around each request. All are optional, may be async
 * (awaited inline), and NEVER receive the API key. Use them for logging/metrics —
 * not for mutating the request.
 */
export interface Interceptors {
  onRequest?: (info: RequestLogInfo) => void | Promise<void>;
  onResponse?: (info: ResponseLogInfo) => void | Promise<void>;
  onRetry?: (info: RetryLogInfo) => void | Promise<void>;
}

export interface TransportOptions {
  apiKey: string;
  baseUrl: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  retry: ResolvedRetryPolicy;
  userAgent?: string | undefined;
  interceptors?: Interceptors | undefined;
  /** Injectable for tests. Default: setTimeout-based, abortable. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable for tests. Default: Math.random. */
  random?: () => number;
}

export interface RequestParams {
  method: "GET" | "POST";
  /** Path relative to baseUrl, e.g. "/orders" or "/orders/abc". */
  path: string;
  query?: Record<string, string | number | undefined> | undefined;
  body?: unknown;
  idempotencyKey?: string | undefined;
  /** Override the safe-to-replay determination. Defaults to GET || has-idempotency-key. */
  idempotent?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

export interface RawResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

function buildUrl(baseUrl: string, path: string, query?: RequestParams["query"]): string {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  let url = `${base}${suffix}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) params.set(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }
  return url;
}

/** Read a response body with a hard byte cap, then JSON-parse it. Returns undefined for an empty body. */
async function readJson(res: Response): Promise<unknown> {
  const text = await readBoundedText(res);
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new MyStarsApiError({
      code: "invalid_response",
      status: res.status,
      message: `Response was not valid JSON (HTTP ${res.status})`,
      // A 5xx with an HTML body (Cloudflare/nginx gateway page) is transient → retryable;
      // a 2xx with malformed JSON is not (retrying won't fix a bad success body).
      retryable: res.status >= 500,
      raw: text.slice(0, 500),
    });
  }
}

async function readBoundedText(res: Response): Promise<string> {
  const body = res.body;
  if (!body || typeof body.getReader !== "function") {
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new MyStarsApiError({
        code: "response_too_large",
        status: res.status,
        message: "Response body exceeded the size limit",
      });
    }
    return text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new MyStarsApiError({
          code: "response_too_large",
          status: res.status,
          message: "Response body exceeded the size limit",
        });
      }
      chunks.push(value);
    }
  }
  return new TextDecoder().decode(concat(chunks, total));
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export class Transport {
  private readonly opts: TransportOptions;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;

  constructor(opts: TransportOptions) {
    this.opts = opts;
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
  }

  async request<T>(params: RequestParams): Promise<RawResponse<T>> {
    const url = buildUrl(this.opts.baseUrl, params.path, params.query);
    const idempotent = params.idempotent ?? (params.method === "GET" || params.idempotencyKey !== undefined);
    const policy = this.opts.retry;

    let attempt = 0;
    for (;;) {
      // The caller aborted between attempts — stop without retrying.
      if (params.signal?.aborted) {
        throw new NetworkError({ code: "aborted", status: 0, message: "request aborted by caller" });
      }
      try {
        return await this.attempt<T>(url, params);
      } catch (err) {
        const apiError = err instanceof MyStarsApiError ? err : wrapUnknown(err);
        const ctx: RetryContext = { method: params.method, path: params.path, attempt, idempotent, error: apiError };
        const willRetry =
          attempt < policy.maxRetries && !params.signal?.aborted && policy.retryOn(ctx);
        if (!willRetry) throw apiError;

        const delayMs = computeDelayMs(ctx, policy, this.random);
        if (this.opts.interceptors?.onRetry) {
          await this.opts.interceptors.onRetry({
            method: params.method,
            url,
            attempt: attempt + 1,
            delayMs,
            reason: `${apiError.code} (HTTP ${apiError.status})`,
          });
        }
        await this.sleep(delayMs, params.signal);
        attempt += 1;
      }
    }
  }

  private async attempt<T>(url: string, params: RequestParams): Promise<RawResponse<T>> {
    const headers = new Headers();
    headers.set("Accept", "application/json");
    headers.set("X-Api-Key", this.opts.apiKey);
    if (this.opts.userAgent) headers.set("User-Agent", this.opts.userAgent);
    if (params.idempotencyKey !== undefined) headers.set("Idempotency-Key", params.idempotencyKey);
    let bodyText: string | undefined;
    if (params.body !== undefined) {
      headers.set("Content-Type", "application/json");
      bodyText = JSON.stringify(params.body);
    }

    if (this.opts.interceptors?.onRequest) {
      await this.opts.interceptors.onRequest({
        method: params.method,
        url,
        idempotencyKey: params.idempotencyKey,
      });
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.opts.timeoutMs);
    const onCallerAbort = () => controller.abort();
    params.signal?.addEventListener("abort", onCallerAbort, { once: true });

    const startedAt = Date.now();
    let res: Response;
    let data: unknown;
    try {
      res = await this.opts.fetchImpl(url, {
        method: params.method,
        headers,
        body: bodyText,
        signal: controller.signal,
      });
      // Read the body INSIDE the timeout/abort window. The timer + caller-abort
      // listener stay live (the finally below runs only after this resolves), so a
      // stalled response body trips the timeout / honors a caller abort instead of
      // hanging unbounded. (Previously clearTimeout ran before the body read.)
      data = await readJson(res);
    } catch (err) {
      if (timedOut) {
        throw new TimeoutError({
          code: "timeout",
          status: 0,
          message: `request timed out after ${this.opts.timeoutMs}ms`,
          retryable: true,
        });
      }
      if (params.signal?.aborted) {
        throw new NetworkError({ code: "aborted", status: 0, message: "request aborted by caller" });
      }
      // readJson's own typed failures (invalid_response / response_too_large) are
      // already classified — surface them unchanged, don't relabel as network.
      if (err instanceof MyStarsApiError) throw err;
      throw new NetworkError({
        code: "network",
        status: 0,
        message: err instanceof Error ? err.message : "network request failed",
        retryable: true,
        raw: err,
      });
    } finally {
      clearTimeout(timer);
      params.signal?.removeEventListener("abort", onCallerAbort);
    }

    const durationMs = Date.now() - startedAt;
    const requestId = res.headers.get("x-request-id") ?? undefined;
    if (this.opts.interceptors?.onResponse) {
      await this.opts.interceptors.onResponse({
        method: params.method,
        url,
        status: res.status,
        durationMs,
        requestId,
      });
    }

    if (!res.ok) {
      throw errorFromResponse(res.status, data, res.headers);
    }
    return { status: res.status, data: data as T, headers: res.headers };
  }
}

function wrapUnknown(err: unknown): MyStarsApiError {
  return new NetworkError({
    code: "network",
    status: 0,
    message: err instanceof Error ? err.message : "request failed",
    retryable: true,
    raw: err,
  });
}
