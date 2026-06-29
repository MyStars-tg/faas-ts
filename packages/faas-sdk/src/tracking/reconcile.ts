/**
 * Reconciliation — catch terminal transitions a dropped or dead-lettered webhook
 * missed. Webhook delivery is at-least-once and unordered, so a safety net that
 * diffs the server's order list against your local store closes the gap.
 *
 * Walks `GET /v1/orders` newest-first; for each TERMINAL order your store hasn't
 * recorded (`isKnown` returns false), it's collected (and `onMissed` fired).
 * Stops paginating once it passes `since` (orders are newest-first).
 */

import { isTerminal, type Order, type OrderStatus } from "../types.js";
import type { OrdersPager } from "./pager.js";

/** The slice of the client {@link reconcile} needs (structurally typed to avoid a cycle). */
export interface ReconcileClient {
  listOrders(params?: { status?: OrderStatus; limit?: number }): OrdersPager;
}

/** Options for {@link reconcile} — your store check plus optional status/since/page-size filters. */
export interface ReconcileOptions {
  /** Only reconcile a specific terminal status (else all terminal orders). */
  status?: OrderStatus;
  /** Stop once orders are older than this (orders are newest-first). */
  since?: Date | string;
  /** Page size for the underlying list. */
  limit?: number;
  /** Your store's check: has this terminal order already been processed? */
  isKnown: (order: Order) => boolean | Promise<boolean>;
  /** Fired for each missed terminal order, in newest-first order. */
  onMissed?: (order: Order) => void | Promise<void>;
}

/**
 * Walk the server's orders newest-first and collect TERMINAL orders your store
 * hasn't recorded — the safety net for webhooks that were dropped or dead-lettered.
 *
 * @param client - anything with a `listOrders` returning an {@link OrdersPager} (a `MyStarsClient` fits)
 * @param opts - the {@link ReconcileOptions}; `isKnown` is required, `since` bounds the scan
 * @returns the missed terminal orders, newest-first (also delivered one-by-one to `onMissed`)
 * @throws `MyStarsApiError` if a page fetch fails
 * @example
 * ```ts
 * const missed = await client.reconcile({
 *   since: new Date(Date.now() - 24 * 3600_000),
 *   isKnown: (o) => myStore.has(o.order_id),
 *   onMissed: (o) => myStore.markTerminal(o),
 * });
 * ```
 */
export async function reconcile(client: ReconcileClient, opts: ReconcileOptions): Promise<Order[]> {
  const sinceMs = opts.since !== undefined ? new Date(opts.since).getTime() : undefined;
  const missed: Order[] = [];
  for await (const order of client.listOrders({ status: opts.status, limit: opts.limit })) {
    if (sinceMs !== undefined && new Date(order.created_at).getTime() < sinceMs) break;
    if (!isTerminal(order.status)) continue;
    if (!(await opts.isKnown(order))) {
      missed.push(order);
      await opts.onMissed?.(order);
    }
  }
  return missed;
}
