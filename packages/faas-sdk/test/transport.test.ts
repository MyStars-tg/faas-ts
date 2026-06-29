import { describe, it, expect } from "vitest";
import { Transport, type RequestParams } from "../src/http/transport.js";
import { resolveRetryPolicy, type RetryPolicy } from "../src/http/retry.js";
import { MyStarsApiError, NetworkError, TimeoutError } from "../src/errors.js";
import { mockFetch, immediateSleep, type MockResponseSpec } from "./helpers/mockFetch.js";

const API_KEY = "faas_" + "c".repeat(64);

function makeTransport(
  script: MockResponseSpec[] | Parameters<typeof mockFetch>[0],
  opts: { timeoutMs?: number; retry?: RetryPolicy | false } = {},
) {
  const mf = mockFetch(script);
  const transport = new Transport({
    apiKey: API_KEY,
    baseUrl: "https://api.example.test/v1",
    fetchImpl: mf.fetch,
    timeoutMs: opts.timeoutMs ?? 5_000,
    retry: resolveRetryPolicy(opts.retry ?? false),
    sleep: immediateSleep,
    random: () => 0,
  });
  return { transport, calls: mf.calls };
}

const GET: RequestParams = { method: "GET", path: "/x" };

describe("transport reads the body inside the timeout/abort window", () => {
  it("a hung response body trips the timeout → TimeoutError", async () => {
    const { transport } = makeTransport([{ hangBody: true }], { timeoutMs: 20 });
    await expect(transport.request(GET)).rejects.toBeInstanceOf(TimeoutError);
  });

  it("a caller AbortSignal aborting mid-body → NetworkError (aborted)", async () => {
    const ctrl = new AbortController();
    const { transport } = makeTransport([{ hangBody: true }], { timeoutMs: 5_000 });
    const p = transport.request({ ...GET, signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 10);
    const err = (await p.catch((e: unknown) => e)) as NetworkError;
    expect(err).toBeInstanceOf(NetworkError);
    expect(err).not.toBeInstanceOf(TimeoutError);
    expect(err.code).toBe("aborted");
  });

  it("a thrown fetch is wrapped as NetworkError and retried to success", async () => {
    const { transport, calls } = makeTransport(
      [{ throwError: new Error("ECONNRESET") }, { status: 200, body: { ok: true } }],
      { retry: { maxRetries: 3, baseDelayMs: 1 } },
    );
    const res = await transport.request<{ ok: boolean }>(GET);
    expect(res.data).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it("a thrown fetch with retries disabled surfaces as NetworkError", async () => {
    const { transport, calls } = makeTransport([{ throwError: new Error("boom") }]);
    await expect(transport.request(GET)).rejects.toBeInstanceOf(NetworkError);
    expect(calls).toHaveLength(1);
  });

  it("an oversized response body throws response_too_large (a typed MyStarsApiError, not relabeled network)", async () => {
    const big = "a".repeat(4_000_001); // > MAX_RESPONSE_BYTES (4_000_000)
    const { transport } = makeTransport([{ status: 200, rawBody: big }]);
    const err = (await transport.request(GET).catch((e: unknown) => e)) as MyStarsApiError;
    expect(err).toBeInstanceOf(MyStarsApiError);
    expect(err).not.toBeInstanceOf(NetworkError);
    expect(err.code).toBe("response_too_large");
  });
});
