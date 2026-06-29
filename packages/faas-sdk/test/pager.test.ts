import { describe, it, expect } from "vitest";
import { OrdersPager } from "../src/tracking/pager.js";
import type { Order, OrdersPage } from "../src/types.js";

function order(id: string): Order {
  return {
    order_id: id,
    status: "delivered",
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
    created_at: "2026-06-25T00:00:00Z",
    updated_at: "2026-06-25T00:00:00Z",
    expires_at: null,
  };
}

describe("OrdersPager", () => {
  it("walks pages until next_cursor is null", async () => {
    const pages: Record<string, OrdersPage> = {
      start: { orders: [order("a"), order("b")], next_cursor: "c1" },
      c1: { orders: [order("c")], next_cursor: null },
    };
    const seen: (string | undefined)[] = [];
    const pager = new OrdersPager((cursor) => {
      seen.push(cursor);
      return Promise.resolve(pages[cursor ?? "start"]!);
    });
    const ids = (await pager.all()).map((o) => o.order_id);
    expect(ids).toEqual(["a", "b", "c"]);
    expect(seen).toEqual([undefined, "c1"]);
  });

  it("yields pages one at a time via pages()", async () => {
    const pager = new OrdersPager(() => Promise.resolve({ orders: [order("x")], next_cursor: null }));
    const collected: OrdersPage[] = [];
    for await (const page of pager.pages()) collected.push(page);
    expect(collected).toHaveLength(1);
    expect(collected[0]!.orders[0]!.order_id).toBe("x");
  });

  it("page() fetches a single page at the given cursor", async () => {
    const pager = new OrdersPager((cursor) => Promise.resolve({ orders: [order(cursor ?? "first")], next_cursor: null }));
    const page = await pager.page("cur-7");
    expect(page.orders[0]!.order_id).toBe("cur-7");
  });
});
