import { describe, it, expect } from "vitest";
import { reconcile } from "../src/tracking/reconcile.js";
import { OrdersPager } from "../src/tracking/pager.js";
import type { Order, OrderStatus } from "../src/types.js";

function order(id: string, status: OrderStatus, createdAt: string): Order {
  return {
    order_id: id,
    status,
    type: "stars",
    recipient_username: "durov",
    quantity: 100,
    months: null,
    amount_ton: "1.0",
    payment_tx: null,
    purchase_tx: null,
    failure_reason: null,
    reversal_tx: null,
    telegram_message: null,
    created_at: createdAt,
    updated_at: createdAt,
    expires_at: null,
  };
}

function clientWith(orders: Order[]) {
  return {
    listOrders: () => new OrdersPager(() => Promise.resolve({ orders, next_cursor: null })),
  };
}

describe("reconcile", () => {
  it("returns terminal orders the local store hasn't recorded", async () => {
    const orders = [
      order("a", "delivered", "2026-06-25T03:00:00Z"),
      order("b", "awaiting_payment", "2026-06-25T02:00:00Z"), // not terminal → skipped
      order("c", "failed", "2026-06-25T01:00:00Z"),
    ];
    const known = new Set(["a"]); // 'a' already processed
    const missed = await reconcile(clientWith(orders), { isKnown: (o) => known.has(o.order_id) });
    expect(missed.map((o) => o.order_id)).toEqual(["c"]);
  });

  it("fires onMissed for each missed order", async () => {
    const orders = [order("x", "reversed", "2026-06-25T03:00:00Z")];
    const seen: string[] = [];
    await reconcile(clientWith(orders), { isKnown: () => false, onMissed: (o) => void seen.push(o.order_id) });
    expect(seen).toEqual(["x"]);
  });

  it("stops once orders are older than `since` (newest-first)", async () => {
    const orders = [
      order("new", "delivered", "2026-06-25T03:00:00Z"),
      order("old", "delivered", "2026-06-20T00:00:00Z"), // before the cutoff → loop breaks
    ];
    const missed = await reconcile(clientWith(orders), { isKnown: () => false, since: "2026-06-24T00:00:00Z" });
    expect(missed.map((o) => o.order_id)).toEqual(["new"]);
  });

  it("supports an async isKnown", async () => {
    const orders = [order("p", "delivered", "2026-06-25T03:00:00Z")];
    const missed = await reconcile(clientWith(orders), { isKnown: () => Promise.resolve(true) });
    expect(missed).toEqual([]);
  });
});
