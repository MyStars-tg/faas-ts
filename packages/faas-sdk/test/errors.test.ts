import { describe, it, expect } from "vitest";
import {
  errorFromResponse,
  parseRetryAfterMs,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  IdempotencyConflictError,
  OrderNotCancellableError,
  RecipientIneligibleError,
  RateLimitError,
  ServiceUnavailableError,
  InternalServerError,
} from "../src/errors.js";

function env(code: string, message: string, extra: Record<string, unknown> = {}) {
  return { error: { code, message }, ...extra };
}

describe("errorFromResponse — code → class", () => {
  it("maps the standard codes", () => {
    const h = new Headers();
    expect(errorFromResponse(400, env("bad_request", "bad"), h)).toBeInstanceOf(BadRequestError);
    expect(errorFromResponse(401, env("unauthorized", "no key"), h)).toBeInstanceOf(UnauthorizedError);
    expect(errorFromResponse(403, env("forbidden", "suspended"), h)).toBeInstanceOf(ForbiddenError);
    expect(errorFromResponse(404, env("not_found", "order not found"), h)).toBeInstanceOf(NotFoundError);
    expect(errorFromResponse(503, env("unavailable", "down"), h)).toBeInstanceOf(ServiceUnavailableError);
    expect(errorFromResponse(500, env("internal", "boom"), h)).toBeInstanceOf(InternalServerError);
  });

  it("handles the bare {\"error\":\"not_found\"} unmatched-route form", () => {
    const err = errorFromResponse(404, { error: "not_found" }, new Headers());
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.code).toBe("not_found");
  });

  it("distinguishes the two 409 conflict subtypes by message", () => {
    const idem = errorFromResponse(409, env("conflict", "Idempotency-Key reused with a different request body"), new Headers());
    expect(idem).toBeInstanceOf(IdempotencyConflictError);
    const cancel = errorFromResponse(409, env("conflict", "order is delivered, cannot cancel"), new Headers());
    expect(cancel).toBeInstanceOf(OrderNotCancellableError);
    const generic = errorFromResponse(409, env("conflict", "something else"), new Headers());
    expect(generic).toBeInstanceOf(ConflictError);
    expect(generic).not.toBeInstanceOf(IdempotencyConflictError);
  });

  it("surfaces telegram_message on 422 recipient_ineligible (the real envelope shape)", () => {
    // The server's 422 body carries only error.{code,message,telegram_message} — no top-level reason.
    const body = { error: { code: "recipient_ineligible", message: "recipient cannot receive item", telegram_message: "Already a Premium subscriber" } };
    const err = errorFromResponse(422, body, new Headers()) as RecipientIneligibleError;
    expect(err).toBeInstanceOf(RecipientIneligibleError);
    expect(err.telegramMessage).toBe("Already a Premium subscriber");
    expect(err.code).toBe("recipient_ineligible");
  });

  it("captures x-request-id", () => {
    const err = errorFromResponse(500, env("internal", "x"), new Headers({ "x-request-id": "req-9" }));
    expect(err.requestId).toBe("req-9");
  });
});

describe("errorFromResponse — 429 rate limiting", () => {
  it("classifies the general limiter (RateLimit-* present) and parses Retry-After", () => {
    const headers = new Headers({
      "ratelimit-limit": "60",
      "ratelimit-remaining": "0",
      "ratelimit-reset": "12",
      "retry-after": "2",
    });
    const err = errorFromResponse(429, env("rate_limited", "rate limit exceeded"), headers) as RateLimitError;
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.kind).toBe("general");
    expect(err.retryAfterMs).toBe(2000);
    expect(err.limit).toBe(60);
    expect(err.remaining).toBe(0);
    expect(err.retryable).toBe(true);
  });

  it("classifies the order-cap limiter (no RateLimit-* headers) as non-retryable", () => {
    const err = errorFromResponse(429, env("rate_limited", "daily order cap reached"), new Headers()) as RateLimitError;
    expect(err.kind).toBe("order_cap");
    expect(err.retryAfterMs).toBeNull();
    expect(err.retryable).toBe(false);
  });
});

describe("parseRetryAfterMs", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfterMs("3")).toBe(3000);
    expect(parseRetryAfterMs("0")).toBe(0);
  });
  it("parses an HTTP-date relative to now", () => {
    const now = Date.parse("2026-06-25T00:00:00.000Z");
    expect(parseRetryAfterMs("Thu, 25 Jun 2026 00:00:05 GMT", now)).toBe(5000);
  });
  it("returns null for an absent or unparseable value", () => {
    expect(parseRetryAfterMs(undefined)).toBeNull();
    expect(parseRetryAfterMs("soon")).toBeNull();
  });
});
