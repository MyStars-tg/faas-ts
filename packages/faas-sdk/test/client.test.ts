import { describe, it, expect } from "vitest";
import { MyStarsClient, PRODUCTION_BASE_URL } from "../src/client.js";
import { MyStarsApiError } from "../src/errors.js";
import { MyStarsValidationError } from "../src/internal/validate.js";
import { mockFetch, immediateSleep, type MockResponseSpec } from "./helpers/mockFetch.js";

const API_KEY = "faas_" + "a".repeat(64);

function makeClient(script: MockResponseSpec[] | Parameters<typeof mockFetch>[0]) {
  const mf = mockFetch(script);
  const client = new MyStarsClient({
    apiKey: API_KEY,
    fetch: mf.fetch,
    retry: false,
    sleep: immediateSleep,
    random: () => 0.5,
    now: () => 1_000_000,
  });
  return { client, calls: mf.calls };
}

const QUOTE = {
  type: "stars",
  quantity: 100,
  months: null,
  amount: "1.2345",
  currency: "ton",
  fee: null,
  usdt_per_ton: "5.5",
  quoted_at: "2026-06-25T00:00:00.000Z",
  valid_until: "2026-06-25T00:01:00.000Z",
};

const CREATED = {
  order_id: "3b488cdf-1f0a-4d3e-9a21-000000000000",
  status: "awaiting_payment",
  type: "stars",
  quantity: 100,
  months: null,
  payment: {
    currency: "ton",
    chain: "ton",
    pay_to_address: "EQexample",
    memo: "3b488cdf-1f0a-4d3e-9a21-000000000000",
    amount: "1.2345",
    amount_units: "ton",
    fee: null,
  },
  expires_at: "2026-06-25T00:15:00.000Z",
};

const ORDER = {
  order_id: "3b488cdf-1f0a-4d3e-9a21-000000000000",
  status: "delivered",
  type: "stars",
  recipient_username: "durov",
  quantity: 100,
  months: null,
  amount_ton: "1.2",
  payment_tx: "abc",
  purchase_tx: "def",
  failure_reason: null,
  reversal_tx: null,
  telegram_message: null,
  created_at: "2026-06-25T00:00:00.000Z",
  updated_at: "2026-06-25T00:05:00.000Z",
  expires_at: null,
};

describe("auth + base url", () => {
  it("sends X-Api-Key and Accept on every request, never an Idempotency-Key on reads", async () => {
    const { client, calls } = makeClient([{ status: 200, body: { currencies: [] } }]);
    await client.listCurrencies();
    expect(calls[0]!.url).toBe(`${PRODUCTION_BASE_URL}/currencies`);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.headers["x-api-key"]).toBe(API_KEY);
    expect(calls[0]!.headers["accept"]).toBe("application/json");
    expect(calls[0]!.headers["idempotency-key"]).toBeUndefined();
  });
});

describe("getPricing", () => {
  it("builds the stars query with quantity + payment_currency", async () => {
    const { client, calls } = makeClient([{ status: 200, body: QUOTE }]);
    const quote = await client.getPricing({ type: "stars", quantity: 100, payment_currency: "ton" });
    expect(quote.amount).toBe("1.2345");
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v1/pricing");
    expect(url.searchParams.get("type")).toBe("stars");
    expect(url.searchParams.get("quantity")).toBe("100");
    expect(url.searchParams.get("payment_currency")).toBe("ton");
  });

  it("builds the premium query with months", async () => {
    const { client, calls } = makeClient([{ status: 200, body: { ...QUOTE, type: "premium", quantity: null, months: 3 } }]);
    await client.getPricing({ type: "premium", months: 3 });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("months")).toBe("3");
    expect(url.searchParams.get("quantity")).toBeNull();
  });

  it("validates the stars quantity range before any request", async () => {
    const { client, calls } = makeClient([{ status: 200, body: QUOTE }]);
    await expect(client.getPricing({ type: "stars", quantity: 10 })).rejects.toBeInstanceOf(MyStarsValidationError);
    expect(calls).toHaveLength(0);
  });

  it("preserves the usdt fee breakdown", async () => {
    const fee = { subtotal: "5.00", processing_fee: "0.56", total: "5.56", description: "1% swap + 0.5 GRAM gas", currency: "usdt" };
    const { client } = makeClient([{ status: 200, body: { ...QUOTE, currency: "usdt_ton", fee } }]);
    const quote = await client.getPricing({ type: "stars", quantity: 100, payment_currency: "usdt_ton" });
    expect(quote.fee).toEqual(fee);
  });
});

describe("checkRecipient", () => {
  it("canonicalizes the username (strips @, lowercases) in the POST body", async () => {
    const { client, calls } = makeClient([
      { status: 200, body: { resolved: true, eligible: true, recipient_name: "Pavel", reason: null, telegram_message: null } },
    ]);
    const res = await client.checkRecipient({ type: "stars", recipient: { username: "@Durov" } });
    expect(res.eligible).toBe(true);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ type: "stars", recipient: { username: "durov" } });
  });

  it("rejects an invalid username before any request", async () => {
    const { client, calls } = makeClient([{ status: 200, body: {} }]);
    await expect(
      client.checkRecipient({ type: "stars", recipient: { username: "bad name!" } }),
    ).rejects.toBeInstanceOf(MyStarsValidationError);
    expect(calls).toHaveLength(0);
  });
});

describe("createOrder", () => {
  it("sends an auto-generated Idempotency-Key and reports replayed=false on 201", async () => {
    const { client, calls } = makeClient([{ status: 201, body: CREATED }]);
    const res = await client.createOrder({ type: "stars", recipient: { username: "durov" }, quantity: 100 });
    expect(res.order_id).toBe(CREATED.order_id);
    expect(res.replayed).toBe(false);
    expect(res.payment.memo).toBe(CREATED.order_id);
    expect(calls[0]!.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reports replayed=true on a 200 idempotent replay", async () => {
    const { client } = makeClient([{ status: 200, body: CREATED }]);
    const res = await client.createOrder({ type: "stars", recipient: { username: "durov" }, quantity: 100 });
    expect(res.replayed).toBe(true);
  });

  it("honors a caller-supplied idempotency key", async () => {
    const { client, calls } = makeClient([{ status: 201, body: CREATED }]);
    await client.createOrder(
      { type: "stars", recipient: { username: "durov" }, quantity: 100 },
      { idempotencyKey: "my-key-123" },
    );
    expect(calls[0]!.headers["idempotency-key"]).toBe("my-key-123");
  });

  it("stamps the used Idempotency-Key onto a thrown error so it can be retried safely", async () => {
    let seenKey: string | undefined;
    const { client } = makeClient((call) => {
      seenKey = call.headers["idempotency-key"];
      return { status: 500, body: { error: { code: "internal", message: "boom" } } };
    });
    const err = await client
      .createOrder({ type: "stars", recipient: { username: "durov" }, quantity: 100 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MyStarsApiError);
    expect((err as MyStarsApiError).idempotencyKey).toBe(seenKey);
    expect(seenKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("a retry with the surfaced key reaches the server replay (200 → replayed:true)", async () => {
    // First create throws; capture its key, then retry with it → server returns the replay.
    const keys: string[] = [];
    const { client } = makeClient((call) => {
      keys.push(call.headers["idempotency-key"]!);
      return keys.length === 1
        ? { status: 503, body: { error: { code: "unavailable", message: "down" } } }
        : { status: 200, body: CREATED };
    });
    const err = (await client
      .createOrder({ type: "stars", recipient: { username: "durov" }, quantity: 100 })
      .catch((e: unknown) => e)) as MyStarsApiError;
    expect(err.idempotencyKey).toBeDefined();
    const replay = await client.createOrder(
      { type: "stars", recipient: { username: "durov" }, quantity: 100 },
      { idempotencyKey: err.idempotencyKey! },
    );
    expect(replay.replayed).toBe(true);
    expect(keys[0]).toBe(keys[1]); // the same key reached the server on the retry
  });

  it("includes callback_url and payment_currency when provided", async () => {
    const { client, calls } = makeClient([{ status: 201, body: CREATED }]);
    await client.createOrder({
      type: "premium",
      recipient: { username: "durov" },
      months: 6,
      payment_currency: "usdt_ton",
      callback_url: "https://example.com/hook",
    });
    const body = JSON.parse(calls[0]!.body!);
    expect(body).toMatchObject({ type: "premium", months: 6, payment_currency: "usdt_ton", callback_url: "https://example.com/hook" });
  });
});

describe("getOrder + cancelOrder", () => {
  it("fetches one order by id", async () => {
    const { client, calls } = makeClient([{ status: 200, body: ORDER }]);
    const order = await client.getOrder(ORDER.order_id);
    expect(order.status).toBe("delivered");
    expect(calls[0]!.url).toBe(`${PRODUCTION_BASE_URL}/orders/${ORDER.order_id}`);
  });

  it("cancels an order", async () => {
    const { client, calls } = makeClient([{ status: 200, body: { order_id: ORDER.order_id, status: "cancelled" } }]);
    const res = await client.cancelOrder(ORDER.order_id);
    expect(res.status).toBe("cancelled");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(`${PRODUCTION_BASE_URL}/orders/${ORDER.order_id}/cancel`);
  });
});

describe("listOrders pagination", () => {
  it("auto-paginates across pages and terminates on a null next_cursor", async () => {
    const page1 = { orders: [{ ...ORDER, order_id: "a" }], next_cursor: "cur1" };
    const page2 = { orders: [{ ...ORDER, order_id: "b" }], next_cursor: null };
    const { client, calls } = makeClient((call) => {
      const url = new URL(call.url);
      return { status: 200, body: url.searchParams.get("cursor") === "cur1" ? page2 : page1 };
    });
    const ids: string[] = [];
    for await (const order of client.listOrders({ status: "delivered" })) ids.push(order.order_id);
    expect(ids).toEqual(["a", "b"]);
    expect(calls).toHaveLength(2);
    expect(new URL(calls[0]!.url).searchParams.get("status")).toBe("delivered");
  });

  it("pager.all() collects every order", async () => {
    const { client } = makeClient([{ status: 200, body: { orders: [ORDER, ORDER], next_cursor: null } }]);
    const all = await client.listOrders().all();
    expect(all).toHaveLength(2);
  });
});

describe("reconcile (instance method)", () => {
  it("delegates to listOrders and returns webhook-missed terminal orders", async () => {
    const { client } = makeClient([
      { status: 200, body: { orders: [{ ...ORDER, order_id: "miss", status: "delivered" }], next_cursor: null } },
    ]);
    const missed = await client.reconcile({ isKnown: () => false });
    expect(missed.map((o) => o.order_id)).toEqual(["miss"]);
  });
});

describe("observability", () => {
  it("never exposes the API key to interceptors", async () => {
    const seen: string[] = [];
    const mf = mockFetch([{ status: 200, body: { currencies: [] }, headers: { "x-request-id": "req-1" } }]);
    const client = new MyStarsClient({
      apiKey: API_KEY,
      fetch: mf.fetch,
      retry: false,
      interceptors: {
        onRequest: (i) => seen.push(JSON.stringify(i)),
        onResponse: (i) => seen.push(JSON.stringify(i)),
      },
    });
    await client.listCurrencies();
    const blob = seen.join("|");
    expect(blob).not.toContain(API_KEY);
    expect(blob).toContain("req-1");
  });
});
