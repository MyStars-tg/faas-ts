/**
 * Retry policy + backoff for transient failures.
 *
 * Only retries when the request is idempotency-safe AND the failure is
 * transient. Crucially, a `createOrder` retry reuses the SAME `Idempotency-Key`
 * (the transport guarantees this), so a retried create returns the server's
 * idempotent replay instead of minting a duplicate deliverable.
 */

import {
  type MyStarsApiError,
  NetworkError,
  RateLimitError,
  ServiceUnavailableError,
  InternalServerError,
} from "../errors.js";

/** The decision context handed to {@link RetryPolicy.retryOn} / {@link defaultShouldRetry} for one failed attempt. */
export interface RetryContext {
  method: string;
  path: string;
  /** 0-based index of the attempt that just failed. */
  attempt: number;
  /** Whether this request is safe to replay (GET, or any request carrying an Idempotency-Key). */
  idempotent: boolean;
  /** The classified error from the failed attempt. */
  error: MyStarsApiError;
}

/**
 * Tunable retry policy passed to `MyStarsClient` (`retry`). Pass `false` instead
 * to disable retries; omit a field to keep its default.
 */
export interface RetryPolicy {
  /** Max retries AFTER the first attempt. Default 3. */
  maxRetries?: number;
  /** Base backoff delay in ms. Default 500. */
  baseDelayMs?: number;
  /** Backoff cap in ms. Default 30_000. */
  maxDelayMs?: number;
  /** Jitter strategy. Default "full". */
  jitter?: "full" | "none";
  /** Honor a 429 `Retry-After` header as a lower bound on the delay. Default true. */
  respectRetryAfter?: boolean;
  /** Override the default retry classifier entirely. */
  retryOn?: (ctx: RetryContext) => boolean;
}

export interface ResolvedRetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: "full" | "none";
  respectRetryAfter: boolean;
  retryOn: (ctx: RetryContext) => boolean;
}

/**
 * The built-in classifier: retry idempotent requests on network/timeout/503/500,
 * the general 429, and any other error flagged transient (e.g. a 502/504 gateway
 * error, which `errorFromResponse` maps to a base error with `retryable: true`).
 */
export function defaultShouldRetry(ctx: RetryContext): boolean {
  if (!ctx.idempotent) return false;
  const e = ctx.error;
  if (e instanceof NetworkError) return true; // also covers TimeoutError
  if (e instanceof ServiceUnavailableError) return true;
  if (e instanceof InternalServerError) return true;
  if (e instanceof RateLimitError) return e.kind === "general";
  return e.retryable; // base/gateway errors (502/504/etc.) carry retryable=true
}

const DEFAULTS: ResolvedRetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  jitter: "full",
  respectRetryAfter: true,
  retryOn: defaultShouldRetry,
};

export function resolveRetryPolicy(policy: RetryPolicy | false | undefined): ResolvedRetryPolicy {
  if (policy === false) return { ...DEFAULTS, maxRetries: 0 };
  if (!policy) return DEFAULTS;
  return {
    maxRetries: policy.maxRetries ?? DEFAULTS.maxRetries,
    baseDelayMs: policy.baseDelayMs ?? DEFAULTS.baseDelayMs,
    maxDelayMs: policy.maxDelayMs ?? DEFAULTS.maxDelayMs,
    jitter: policy.jitter ?? DEFAULTS.jitter,
    respectRetryAfter: policy.respectRetryAfter ?? DEFAULTS.respectRetryAfter,
    retryOn: policy.retryOn ?? DEFAULTS.retryOn,
  };
}

/** Compute the backoff delay (ms) before the next attempt. */
export function computeDelayMs(
  ctx: RetryContext,
  policy: ResolvedRetryPolicy,
  random: () => number = Math.random,
): number {
  const exp = policy.baseDelayMs * 2 ** ctx.attempt;
  const capped = Math.min(exp, policy.maxDelayMs);
  let delay = policy.jitter === "full" ? random() * capped : capped;
  if (policy.respectRetryAfter && ctx.error instanceof RateLimitError && ctx.error.retryAfterMs !== null) {
    // Honor Retry-After as a LOWER bound, but cap it by maxDelayMs so a hostile
    // or absurd header (e.g. "Retry-After: 86400") can't park the client for a day.
    delay = Math.max(delay, Math.min(ctx.error.retryAfterMs, policy.maxDelayMs));
  }
  return Math.round(delay);
}
