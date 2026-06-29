/**
 * Typed error taxonomy for the MyStars FaaS SDK.
 *
 * The server returns an envelope `{ error: { code, message, telegram_message? } }`
 * for handled errors, and a bare `{ "error": "not_found" }` string for unmatched
 * routes. `errorFromResponse` maps both forms — plus network/timeout failures —
 * to the right class, keyed on the envelope `code` (the code, not the HTTP
 * status, is authoritative; an unknown future code falls back to the base class
 * so the SDK never crashes on a new code).
 */

import type { Order } from "./types.js";

/** Base class for every error this SDK throws. */
export abstract class MyStarsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    // Restore the prototype chain across the TS `extends Error` downlevel.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface ApiErrorInit {
  code: string;
  status: number;
  message: string;
  telegramMessage?: string | undefined;
  requestId?: string | undefined;
  retryable?: boolean;
  raw?: unknown;
  /** The `Idempotency-Key` that was sent with the failed request (set by `createOrder`). */
  idempotencyKey?: string | undefined;
}

/** Any error originating from an HTTP response (or a failed attempt to make one). */
export class MyStarsApiError extends MyStarsError {
  /** The envelope `error.code`, or `"unknown"` / `"network"`. */
  readonly code: string;
  /** HTTP status code (`0` for a network/timeout failure). */
  readonly status: number;
  /** Buyer-facing Telegram/Fragment message, when the server supplied one. */
  readonly telegramMessage?: string;
  /** The `x-request-id` response header, when present. */
  readonly requestId?: string;
  /** Coarse hint that the failure is potentially transient. The retry policy decides for real. */
  readonly retryable: boolean;
  /** The parsed response body (or the thrown error), for debugging. */
  readonly raw?: unknown;
  /**
   * The `Idempotency-Key` that was sent with the request that failed, when known.
   *
   * `createOrder` stamps this on a thrown error so you can SAFELY retry the
   * create with the SAME key (`{ idempotencyKey: err.idempotencyKey }`) instead
   * of minting a duplicate deliverable when you can't tell whether the order was
   * created server-side. `undefined` for errors not raised by a keyed request.
   */
  readonly idempotencyKey?: string;

  constructor(init: ApiErrorInit) {
    super(init.message);
    this.code = init.code;
    this.status = init.status;
    this.telegramMessage = init.telegramMessage;
    this.requestId = init.requestId;
    this.retryable = init.retryable ?? false;
    this.raw = init.raw;
    this.idempotencyKey = init.idempotencyKey;
  }
}

/** 400 — malformed request, validation failure, or missing `Idempotency-Key`. */
export class BadRequestError extends MyStarsApiError {}
/** 401 — missing or invalid `X-Api-Key`. */
export class UnauthorizedError extends MyStarsApiError {}
/** 403 — the API key is valid but the tenant is suspended or banned. */
export class ForbiddenError extends MyStarsApiError {}
/** 404 — order not found (or an unmatched route). */
export class NotFoundError extends MyStarsApiError {}
/** 409 — a generic conflict. */
export class ConflictError extends MyStarsApiError {}
/** 409 — the same `Idempotency-Key` was reused with a different request body. */
export class IdempotencyConflictError extends ConflictError {}
/** 409 — the order is not in `awaiting_payment` and cannot be cancelled. */
export class OrderNotCancellableError extends ConflictError {}

/**
 * 422 — the recipient cannot receive the item; no order was created.
 *
 * The server's 422 body carries only `telegram_message` (the buyer-facing reason
 * to show your user) — NOT a structured `reason` code. For the structured
 * `reason` (`already_subscribed` | `not_found` | `ineligible`), call
 * `client.checkRecipient(...)` first and read its `reason` field.
 */
export class RecipientIneligibleError extends MyStarsApiError {
  override readonly telegramMessage: string;

  constructor(init: ApiErrorInit) {
    super(init);
    this.telegramMessage = init.telegramMessage ?? init.message;
  }
}

/** Which limiter a {@link RateLimitError} came from: the per-minute limiter or the daily order-cap/flood guard. */
export type RateLimitKind = "general" | "order_cap";

/** 429 — rate limited. `kind` distinguishes the per-minute limiter from the daily order cap / flood guard. */
export class RateLimitError extends MyStarsApiError {
  /** Milliseconds to wait before retrying, from `Retry-After`; `null` for the order-cap/flood limiter. */
  readonly retryAfterMs: number | null;
  readonly limit: number | null;
  readonly remaining: number | null;
  readonly reset: number | null;
  /** `"general"` when RFC-9110 `RateLimit-*` headers are present; `"order_cap"` otherwise. */
  readonly kind: RateLimitKind;

  constructor(
    init: ApiErrorInit & {
      retryAfterMs?: number | null;
      limit?: number | null;
      remaining?: number | null;
      reset?: number | null;
      kind: RateLimitKind;
    },
  ) {
    super(init);
    this.retryAfterMs = init.retryAfterMs ?? null;
    this.limit = init.limit ?? null;
    this.remaining = init.remaining ?? null;
    this.reset = init.reset ?? null;
    this.kind = init.kind;
  }
}

/** 503 — a price source or upstream dependency is temporarily unavailable. Retryable. */
export class ServiceUnavailableError extends MyStarsApiError {}
/** 500 — an unhandled server error. */
export class InternalServerError extends MyStarsApiError {}

/** The request never produced an HTTP response (DNS, connection reset, aborted, etc.). */
export class NetworkError extends MyStarsApiError {}
/** The request exceeded the configured timeout. */
export class TimeoutError extends NetworkError {}

/** A webhook payload failed signature verification (or the header was missing/malformed). */
export class WebhookSignatureError extends MyStarsError {}

/** `waitForOrder` gave up before the order reached a terminal state. */
export class OrderWaitTimeoutError extends MyStarsError {
  /** The most recent order snapshot observed before timing out. */
  readonly lastOrder: Order;
  constructor(lastOrder: Order, message?: string) {
    super(message ?? `order ${lastOrder.order_id} did not finish in time (last status: ${lastOrder.status})`);
    this.lastOrder = lastOrder;
  }
}

function header(headers: Headers, name: string): string | undefined {
  const v = headers.get(name);
  return v === null ? undefined : v;
}

function toInt(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Parse a `Retry-After` header (delta-seconds, or an HTTP-date) into milliseconds. */
export function parseRetryAfterMs(value: string | undefined, now: number = Date.now()): number | null {
  if (value === undefined) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return null;
}

interface ParsedEnvelope {
  code: string;
  message: string;
  telegramMessage?: string;
}

/** Extract `{code,message,telegram_message}` from either the object or bare-string error forms. */
function parseEnvelope(status: number, body: unknown): ParsedEnvelope {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error: unknown }).error;
    // Standard enveloped form: { error: { code, message, telegram_message? } }
    if (err && typeof err === "object") {
      const e = err as Record<string, unknown>;
      return {
        code: typeof e.code === "string" ? e.code : "unknown",
        message: typeof e.message === "string" ? e.message : `HTTP ${status}`,
        telegramMessage: typeof e.telegram_message === "string" ? e.telegram_message : undefined,
      };
    }
    // Bare-string form for unmatched routes: { "error": "not_found" }
    if (typeof err === "string") {
      return { code: err, message: err };
    }
  }
  return { code: "unknown", message: `HTTP ${status}` };
}

/** Map an HTTP response (status + parsed body + headers) to the appropriate typed error. */
export function errorFromResponse(status: number, body: unknown, headers: Headers): MyStarsApiError {
  const { code, message, telegramMessage } = parseEnvelope(status, body);
  const requestId = header(headers, "x-request-id");
  const base: ApiErrorInit = { code, status, message, telegramMessage, requestId, raw: body };

  switch (status) {
    case 400:
      return new BadRequestError(base);
    case 401:
      return new UnauthorizedError(base);
    case 403:
      return new ForbiddenError(base);
    case 404:
      return new NotFoundError(base);
    case 409: {
      const m = message.toLowerCase();
      if (m.includes("idempotency")) return new IdempotencyConflictError(base);
      if (m.includes("cancel")) return new OrderNotCancellableError(base);
      return new ConflictError(base);
    }
    case 422:
      return new RecipientIneligibleError(base);
    case 429: {
      const limit = toInt(header(headers, "ratelimit-limit"));
      const remaining = toInt(header(headers, "ratelimit-remaining"));
      const reset = toInt(header(headers, "ratelimit-reset"));
      const retryAfterMs = parseRetryAfterMs(header(headers, "retry-after"));
      // The general per-minute limiter emits RateLimit-* headers; the daily
      // order-cap / per-recipient flood guard does not.
      const kind: RateLimitKind = limit !== null || retryAfterMs !== null ? "general" : "order_cap";
      return new RateLimitError({
        ...base,
        retryable: kind === "general",
        retryAfterMs,
        limit,
        remaining,
        reset,
        kind,
      });
    }
    case 503:
      return new ServiceUnavailableError({ ...base, retryable: true });
    case 500:
      return new InternalServerError({ ...base, retryable: true });
    default:
      return new MyStarsApiError({ ...base, retryable: status >= 500 });
  }
}
