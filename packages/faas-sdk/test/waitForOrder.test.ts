import { describe, it, expect } from "vitest";
import { waitForOrder, type WaitForOrderDeps } from "../src/tracking/waitForOrder.js";
import { OrderWaitTimeoutError } from "../src/errors.js";
import type { Order, OrderStatus } from "../src/types.js";

function order(status: OrderStatus): Order {
  return {
    order_id: "o1",
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
    created_at: "2026-06-25T00:00:00Z",
    updated_at: "2026-06-25T00:00:00Z",
    expires_at: null,
  };
}

function deps(statuses: OrderStatus[], clock = { t: 0 }): WaitForOrderDeps {
  let i = 0;
  return {
    getOrder: () => Promise.resolve(order(statuses[Math.min(i++, statuses.length - 1)]!)),
    sleep: (ms) => {
      clock.t += ms;
      return Promise.resolve();
    },
    now: () => clock.t,
    random: () => 0.5,
  };
}

describe("waitForOrder", () => {
  it("polls until a terminal status and returns the final order", async () => {
    const final = await waitForOrder("o1", {}, deps(["awaiting_payment", "paid", "delivered"]));
    expect(final.status).toBe("delivered");
  });

  it("fires onUpdate only on status changes", async () => {
    const seen: OrderStatus[] = [];
    await waitForOrder(
      "o1",
      { onUpdate: (o) => seen.push(o.status) },
      deps(["awaiting_payment", "awaiting_payment", "paid", "delivered"]),
    );
    expect(seen).toEqual(["awaiting_payment", "paid", "delivered"]);
  });

  it("honors a custom until() predicate", async () => {
    const final = await waitForOrder("o1", { until: (o) => o.status === "paid" }, deps(["awaiting_payment", "paid", "delivered"]));
    expect(final.status).toBe("paid");
  });

  it("throws OrderWaitTimeoutError carrying the last order when the deadline passes", async () => {
    const clock = { t: 0 };
    await expect(
      waitForOrder("o1", { maxWaitMs: 1000, pollIntervalMs: 600 }, deps(["awaiting_payment", "awaiting_payment", "awaiting_payment"], clock)),
    ).rejects.toMatchObject({ lastOrder: { status: "awaiting_payment" } });
  });

  it("OrderWaitTimeoutError is a typed error", async () => {
    try {
      await waitForOrder("o1", { maxWaitMs: 100, pollIntervalMs: 200 }, deps(["awaiting_payment"]));
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OrderWaitTimeoutError);
    }
  });
});
