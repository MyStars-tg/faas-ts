import { describe, it, expect } from "vitest";
import { MyStarsClient } from "../src/client.js";
import {
  defaultShouldRetry,
  computeDelayMs,
  resolveRetryPolicy,
  type RetryContext,
} from "../src/http/retry.js";
import {
  NetworkError,
  TimeoutError,
  ServiceUnavailableError,
  InternalServerError,
  RateLimitError,
  BadRequestError,
} from "../src/errors.js";
import { mockFetch, immediateSleep, type MockResponseSpec } from "./helpers/mockFetch.js";

const API_KEY = "faas_" + "b".repeat(64);

function ctx(error: RetryContext["error"], idempotent = true): RetryContext {
  return { method: "POST", path: "/orders", attempt: 0, idempotent, error };
}

function netErr() {
  return new NetworkError({ code: "network", status: 0, message: "down", retryable: true });
}

describe("defaultShouldRetry", () => {
  it("retries idempotent network/timeout/503/500", () => {
    expect(defaultShouldRetry(ctx(netErr()))).toBe(true);
    expect(defaultShouldRetry(ctx(new TimeoutError({ code: "timeout", status: 0, message: "t" })))).toBe(true);
    expect(defaultShouldRetry(ctx(new ServiceUnavailableError({ code: "unavailable", status: 503, message: "u" })))).toBe(true);
    expect(defaultShouldRetry(ctx(new InternalServerError({ code: "internal", status: 500, message: "i" })))).toBe(true);
  });

  it("retries the general 429 but not the order-cap 429", () => {
    expect(defaultShouldRetry(ctx(new RateLimitError({ code: "rate_limited", status: 429, message: "r", kind: "general" })))).toBe(true);
    expect(defaultShouldRetry(ctx(new RateLimitError({ code: "rate_limited", status: 429, message: "r", kind: "order_cap" })))).toBe(false);
  });

  it("never retries a non-idempotent request or a 4xx", () => {
    expect(defaultShouldRetry(ctx(netErr(), false))).toBe(false);
    expect(defaultShouldRetry(ctx(new BadRequestError({ code: "bad_request", status: 400, message: "b" })))).toBe(false);
  });
});

describe("computeDelayMs", () => {
  const policy = resolveRetryPolicy({ baseDelayMs: 500, maxDelayMs: 30_000 });

  it("applies exponential backoff with full jitter (bounded by the capped delay)", () => {
    const c: RetryContext = { method: "GET", path: "/x", attempt: 2, idempotent: true, error: netErr() };
    expect(computeDelayMs(c, policy, () => 1)).toBe(2000); // 500 * 2^2
    expect(computeDelayMs(c, policy, () => 0)).toBe(0);
  });

  it("floors the delay to Retry-After when present", () => {
    const err = new RateLimitError({ code: "rate_limited", status: 429, message: "r", kind: "general", retryAfterMs: 2000 });
    const c: RetryContext = { method: "GET", path: "/x", attempt: 0, idempotent: true, error: err };
    expect(computeDelayMs(c, policy, () => 0)).toBe(2000);
  });

  it("caps an absurd Retry-After at maxDelayMs (no day-long park)", () => {
    const err = new RateLimitError({ code: "rate_limited", status: 429, message: "r", kind: "general", retryAfterMs: 86_400_000 });
    const c: RetryContext = { method: "GET", path: "/x", attempt: 0, idempotent: true, error: err };
    expect(computeDelayMs(c, policy, () => 0)).toBe(30_000); // policy.maxDelayMs, not 24h
  });
});

function retryingClient(script: MockResponseSpec[] | Parameters<typeof mockFetch>[0], onRetryDelays?: number[]) {
  const mf = mockFetch(script);
  const client = new MyStarsClient({
    apiKey: API_KEY,
    fetch: mf.fetch,
    retry: { maxRetries: 3, baseDelayMs: 1 },
    sleep: immediateSleep,
    random: () => 0,
    interceptors: onRetryDelays ? { onRetry: (i) => onRetryDelays.push(i.delayMs) } : undefined,
  });
  return { client, calls: mf.calls };
}

const CURRENCIES = { currencies: [{ code: "ton", chain: "ton", name: "GRAM (TON)" }] };

describe("transport retry behavior", () => {
  it("retries a 503 then succeeds", async () => {
    const { client, calls } = retryingClient([
      { status: 503, body: { error: { code: "unavailable", message: "down" } } },
      { status: 200, body: CURRENCIES },
    ]);
    const res = await client.listCurrencies();
    expect(res).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("retries a 502/504 gateway error (retryable flag) then succeeds", async () => {
    const { client, calls } = retryingClient([
      { status: 502, body: { error: { code: "bad_gateway", message: "upstream" } } },
      { status: 504, body: { error: { code: "gateway_timeout", message: "upstream" } } },
      { status: 200, body: CURRENCIES },
    ]);
    const res = await client.listCurrencies();
    expect(res).toHaveLength(1);
    expect(calls).toHaveLength(3);
  });

  it("retries a 5xx with a non-JSON (HTML gateway page) body", async () => {
    const { client, calls } = retryingClient([
      { status: 502, rawBody: "<html><body>502 Bad Gateway</body></html>" },
      { status: 200, body: CURRENCIES },
    ]);
    const res = await client.listCurrencies();
    expect(res).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("does NOT retry a 2xx with a malformed JSON body", async () => {
    const { client, calls } = retryingClient([{ status: 200, rawBody: "not json{" }]);
    await expect(client.listCurrencies()).rejects.toMatchObject({ code: "invalid_response" });
    expect(calls).toHaveLength(1);
  });

  it("honors Retry-After on the general 429", async () => {
    const delays: number[] = [];
    const { client } = retryingClient(
      [
        { status: 429, body: { error: { code: "rate_limited", message: "slow" } }, headers: { "ratelimit-limit": "60", "retry-after": "2" } },
        { status: 200, body: CURRENCIES },
      ],
      delays,
    );
    await client.listCurrencies();
    expect(delays).toEqual([2000]);
  });

  it("does NOT retry the order-cap 429", async () => {
    const { client, calls } = retryingClient([
      { status: 429, body: { error: { code: "rate_limited", message: "daily order cap reached" } } },
    ]);
    await expect(client.createOrder({ type: "stars", recipient: { username: "durov" }, quantity: 100 })).rejects.toMatchObject({ kind: "order_cap" });
    expect(calls).toHaveLength(1);
  });

  it("createOrder reuses the SAME Idempotency-Key across retries", async () => {
    const created = {
      order_id: "id-1",
      status: "awaiting_payment",
      type: "stars",
      quantity: 100,
      months: null,
      payment: { currency: "ton", chain: "ton", pay_to_address: "EQx", memo: "id-1", amount: "1.0", amount_units: "ton", fee: null },
      expires_at: "2026-06-25T00:15:00.000Z",
    };
    const { client, calls } = retryingClient([
      { status: 503, body: { error: { code: "unavailable", message: "down" } } },
      { status: 201, body: created },
    ]);
    await client.createOrder({ type: "stars", recipient: { username: "durov" }, quantity: 100 });
    expect(calls).toHaveLength(2);
    const key0 = calls[0]!.headers["idempotency-key"];
    expect(key0).toBeDefined();
    expect(calls[1]!.headers["idempotency-key"]).toBe(key0);
  });

  it("exhausts maxRetries then throws", async () => {
    const { client, calls } = retryingClient([
      { status: 503, body: { error: { code: "unavailable", message: "down" } } },
    ]);
    await expect(client.listCurrencies()).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(calls).toHaveLength(4); // 1 + 3 retries
  });
});
