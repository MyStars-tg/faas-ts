import { describe, it, expect } from "vitest";
import { MyStarsValidationError, type CreateOrderOptions, type CreateOrderParams, type CreateOrderResult, type Order } from "@mystars-tg/faas-sdk";
import { fulfill, orderIdFromError, type FulfillClient } from "../src/fulfill.js";
import { TonWallet } from "../src/wallet.js";
import type { TonRpc } from "../src/rpc.js";

const CREATED: CreateOrderResult = {
  order_id: "o-1",
  status: "awaiting_payment",
  type: "stars",
  quantity: 100,
  months: null,
  payment: {
    currency: "ton",
    chain: "ton",
    pay_to_address: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs",
    memo: "o-1",
    amount: "1.0",
    amount_units: "ton",
    fee: null,
  },
  expires_at: "2026-06-25T00:15:00Z",
  replayed: false,
};

const DELIVERED: Order = {
  order_id: "o-1",
  status: "delivered",
  type: "stars",
  recipient_username: "durov",
  quantity: 100,
  months: null,
  amount_ton: "1.0",
  payment_tx: "abc",
  purchase_tx: "def",
  failure_reason: null,
  reversal_tx: null,
  telegram_message: null,
  created_at: "2026-06-25T00:00:00Z",
  updated_at: "2026-06-25T00:05:00Z",
  expires_at: null,
};

function rpc(sent: Uint8Array[]): TonRpc {
  return {
    getBalance: () => Promise.resolve(10_000_000_000n),
    getSeqno: () => Promise.resolve(1),
    resolveJettonWallet: () => Promise.resolve("EQjetton"),
    getJettonBalance: () => Promise.resolve(0n),
    sendBoc: (boc) => {
      sent.push(boc);
      return Promise.resolve();
    },
  };
}

describe("fulfill", () => {
  it("creates → pays → waits and returns the final order", async () => {
    const { wallet } = await TonWallet.generate();
    const sent: Uint8Array[] = [];
    const calls: string[] = [];
    const client: FulfillClient = {
      createOrder: () => {
        calls.push("create");
        return Promise.resolve(CREATED);
      },
      waitForOrder: (id) => {
        calls.push(`wait:${id}`);
        return Promise.resolve(DELIVERED);
      },
    };
    const order = await fulfill(client, wallet, { type: "stars", recipient: { username: "durov" }, quantity: 100 }, { rpc: rpc(sent), now: 1_000_000, idempotencyKey: "order-abc" });
    expect(order.status).toBe("delivered");
    expect(sent).toHaveLength(1); // exactly one broadcast (the payment)
    expect(calls).toEqual(["create", "wait:o-1"]);
  });

  it("throws (before creating or paying) when no stable idempotency key is supplied", async () => {
    const { wallet } = await TonWallet.generate();
    const sent: Uint8Array[] = [];
    let created = false;
    const client: FulfillClient = {
      createOrder: () => {
        created = true;
        return Promise.resolve(CREATED);
      },
      waitForOrder: () => Promise.resolve(DELIVERED),
    };
    await expect(
      fulfill(client, wallet, { type: "stars", recipient: { username: "durov" }, quantity: 100 }, { rpc: rpc(sent) }),
    ).rejects.toBeInstanceOf(MyStarsValidationError);
    expect(created).toBe(false); // never reached the server
    expect(sent).toHaveLength(0); // never broadcast
  });

  it("threads the stable key into createOrder and does NOT broadcast twice on a replay (no double-spend)", async () => {
    const { wallet } = await TonWallet.generate();
    const sent: Uint8Array[] = [];
    const keysSeen: (string | undefined)[] = [];
    let call = 0;
    const client: FulfillClient = {
      createOrder: (_params: CreateOrderParams, o?: CreateOrderOptions) => {
        keysSeen.push(o?.idempotencyKey);
        call += 1;
        // 1st call: fresh order awaiting payment. 2nd call (same key): the server
        // returns the SAME order, now already paid (idempotent replay).
        return Promise.resolve(call === 1 ? CREATED : { ...CREATED, status: "paid", replayed: true });
      },
      waitForOrder: () => Promise.resolve(DELIVERED),
    };

    const params: CreateOrderParams = { type: "stars", recipient: { username: "durov" }, quantity: 100 };
    await fulfill(client, wallet, params, { rpc: rpc(sent), now: 1_000_000, idempotencyKey: "order-xyz" });
    await fulfill(client, wallet, params, { rpc: rpc(sent), now: 1_000_000, idempotencyKey: "order-xyz" });

    expect(keysSeen).toEqual(["order-xyz", "order-xyz"]); // same stable key both times
    expect(sent).toHaveLength(1); // paid ONCE — the replay (already paid) skips the broadcast
  });

  it("annotates a post-payment throw with order_id (readable via orderIdFromError) for safe re-attach", async () => {
    const { wallet } = await TonWallet.generate();
    const sent: Uint8Array[] = [];
    const client: FulfillClient = {
      createOrder: () => Promise.resolve(CREATED),
      waitForOrder: () => Promise.reject(new Error("poll timed out")),
    };
    const err = await fulfill(
      client,
      wallet,
      { type: "stars", recipient: { username: "durov" }, quantity: 100 },
      { rpc: rpc(sent), now: 1_000_000, idempotencyKey: "order-xyz" },
    ).catch((e: unknown) => e);
    expect(sent).toHaveLength(1); // payment WAS broadcast — caller must not re-run fulfill
    expect(orderIdFromError(err)).toBe("o-1");
  });

  it("orderIdFromError returns undefined for an unannotated error", () => {
    expect(orderIdFromError(new Error("nope"))).toBeUndefined();
    expect(orderIdFromError(null)).toBeUndefined();
  });
});
