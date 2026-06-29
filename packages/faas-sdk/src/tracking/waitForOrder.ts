/**
 * Poll an order until it reaches a terminal state (or a custom predicate / the
 * deadline). Polling a still-`awaiting_payment` order also nudges the server's
 * on-demand payment detection, so this doubles as a payment tracker.
 */

import { OrderWaitTimeoutError } from "../errors.js";
import { isTerminal, type Order } from "../types.js";

/** Polling/backoff knobs and observation hooks for {@link waitForOrder} / `client.waitForOrder`. */
export interface WaitForOrderOptions {
  /** First poll interval (ms). Default 2000. */
  pollIntervalMs?: number;
  /** Upper bound on the backed-off poll interval (ms). Default 15_000. */
  maxPollIntervalMs?: number;
  /** Multiplier applied to the interval after each poll. Default 1.5. */
  backoffFactor?: number;
  /** Total time to wait before throwing `OrderWaitTimeoutError` (ms). Default 30 min. */
  maxWaitMs?: number;
  /** Apply jitter to the poll interval. Default "full". */
  jitter?: "full" | "none";
  /** Resolve when this returns true. Default: the order is terminal. */
  until?: (order: Order) => boolean;
  /** Called whenever the observed status changes (including the first observation). */
  onUpdate?: (order: Order) => void;
  signal?: AbortSignal;
}

/** Injected dependencies for {@link waitForOrder} (the client supplies these; tests stub them). */
export interface WaitForOrderDeps {
  getOrder: (orderId: string, opts?: { signal?: AbortSignal }) => Promise<Order>;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
  random: () => number;
}

/**
 * Poll an order with capped exponential backoff + jitter until it's terminal (or
 * the `until` predicate is true, or the deadline passes). Prefer the bound
 * `client.waitForOrder(...)` — this is the dependency-injected core it delegates to.
 *
 * @param orderId - the order UUID to poll
 * @param options - the {@link WaitForOrderOptions} (intervals, deadline, `until`, `onUpdate`, `signal`)
 * @param deps - the injected `getOrder`/`sleep`/`now`/`random`
 * @returns the order snapshot once `until` (default: terminal) is satisfied
 * @throws `OrderWaitTimeoutError` if `maxWaitMs` elapses first (carries the last snapshot)
 * @throws `MyStarsApiError` if an underlying `getOrder` fails non-transiently
 */
export async function waitForOrder(
  orderId: string,
  options: WaitForOrderOptions,
  deps: WaitForOrderDeps,
): Promise<Order> {
  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  const maxPollIntervalMs = options.maxPollIntervalMs ?? 15_000;
  const backoffFactor = options.backoffFactor ?? 1.5;
  const maxWaitMs = options.maxWaitMs ?? 30 * 60 * 1000;
  const jitter = options.jitter ?? "full";
  const until = options.until ?? ((o: Order) => isTerminal(o.status));

  const deadline = deps.now() + maxWaitMs;
  let interval = pollIntervalMs;
  let lastStatus: Order["status"] | undefined;
  let lastOrder: Order;

  for (;;) {
    lastOrder = await deps.getOrder(orderId, { signal: options.signal });
    if (lastOrder.status !== lastStatus) {
      lastStatus = lastOrder.status;
      options.onUpdate?.(lastOrder);
    }
    if (until(lastOrder)) return lastOrder;

    const remaining = deadline - deps.now();
    if (remaining <= 0) throw new OrderWaitTimeoutError(lastOrder);

    const base = Math.min(interval, maxPollIntervalMs);
    // Keep jitter in [base/2, base] so polling never collapses to ~0ms.
    const jittered = jitter === "full" ? base * (0.5 + 0.5 * deps.random()) : base;
    await deps.sleep(Math.max(0, Math.min(jittered, remaining)), options.signal);
    interval = Math.min(interval * backoffFactor, maxPollIntervalMs);
  }
}
