import { describe, it, expect } from "vitest";
import type { MyStarsClient } from "@mystars-tg/faas-sdk";
import {
  cmdPricing,
  cmdRecipientCheck,
  cmdOrdersCreate,
  cmdOrdersList,
  cmdWebhookVerify,
  resolveWebhookSecret,
  type CliIO,
} from "../src/commands.js";

function captureIO() {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { out: (s) => out.push(s), err: (s) => err.push(s) };
  return { io, out, err, json: () => JSON.parse(out.join("\n")) };
}

const CREATED = {
  order_id: "o-1",
  status: "awaiting_payment",
  type: "stars",
  quantity: 100,
  months: null,
  payment: { currency: "ton", chain: "ton", pay_to_address: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs", memo: "o-1", amount: "1.5", amount_units: "ton", fee: null },
  expires_at: "2026-06-25T00:15:00Z",
  replayed: false,
};

describe("CLI command handlers", () => {
  it("pricing calls getPricing for stars and prints the quote", async () => {
    let received: unknown;
    const client = {
      getPricing: (p: unknown) => {
        received = p;
        return Promise.resolve({ amount: "1.23", currency: "ton" });
      },
    } as unknown as MyStarsClient;
    const { io, json } = captureIO();
    await cmdPricing(client, { type: "stars", quantity: 100, currency: "ton" }, io);
    expect(received).toEqual({ type: "stars", quantity: 100, payment_currency: "ton" });
    expect(json().amount).toBe("1.23");
  });

  it("recipient-check canonicalizes through the client", async () => {
    const client = {
      checkRecipient: () => Promise.resolve({ eligible: true, resolved: true, recipient_name: "Pavel", reason: null, telegram_message: null }),
    } as unknown as MyStarsClient;
    const { io, json } = captureIO();
    await cmdRecipientCheck(client, { type: "stars", username: "durov" }, io);
    expect(json().eligible).toBe(true);
  });

  it("orders create --pay prints the order plus a payable request", async () => {
    const client = { createOrder: () => Promise.resolve(CREATED) } as unknown as MyStarsClient;
    const { io, json } = captureIO();
    await cmdOrdersCreate(client, { type: "stars", recipient: "durov", quantity: 100, pay: true }, io);
    const result = json();
    expect(result.order.order_id).toBe("o-1");
    expect(result.payment_request.tonDeeplink).toContain("ton://transfer/");
    expect(result.payment_request.amountSmallestUnit).toBe("1500000000");
  });

  it("orders ls fetches a single page", async () => {
    let pageCalled = false;
    const client = {
      listOrders: () => ({ page: () => { pageCalled = true; return Promise.resolve({ orders: [], next_cursor: null }); } }),
    } as unknown as MyStarsClient;
    const { io, json } = captureIO();
    await cmdOrdersList(client, { status: "delivered" }, io);
    expect(pageCalled).toBe(true);
    expect(json().orders).toEqual([]);
  });

  it("webhook-verify reports validity", async () => {
    const secret = "tenant-webhook-secret-aaaaaaaaaaaaaaaaaaaa";
    const body = '{"order_id":"order-123","status":"delivered"}';
    const signature = "e56e9f643c8b3bc9b99253e4cee767528ec1cfc8866eec08a868638b0fbc8194";

    const good = captureIO();
    await cmdWebhookVerify({ secret, body, signature }, good.io);
    expect(good.json().valid).toBe(true);

    const bad = captureIO();
    await cmdWebhookVerify({ secret, body, signature: "bad" }, bad.io);
    expect(bad.json().valid).toBe(false);
  });
});

describe("resolveWebhookSecret", () => {
  const secret = "tenant-webhook-secret-aaaaaaaaaaaaaaaaaaaa";
  const body = '{"order_id":"order-123","status":"delivered"}';
  const signature = "e56e9f643c8b3bc9b99253e4cee767528ec1cfc8866eec08a868638b0fbc8194";

  it("falls back to MYSTARS_WEBHOOK_SECRET when --secret is omitted, and verification uses it", async () => {
    const resolved = resolveWebhookSecret(undefined, { MYSTARS_WEBHOOK_SECRET: secret } as NodeJS.ProcessEnv);
    expect(resolved).toBe(secret);
    const { io, json } = captureIO();
    await cmdWebhookVerify({ secret: resolved, body, signature }, io);
    expect(json().valid).toBe(true);
  });

  it("prefers the env secret over an argv --secret (avoids the process-list leak)", () => {
    expect(resolveWebhookSecret("flag-secret", { MYSTARS_WEBHOOK_SECRET: secret } as NodeJS.ProcessEnv)).toBe(secret);
  });

  it("uses --secret when no env var is set", () => {
    expect(resolveWebhookSecret(secret, {} as NodeJS.ProcessEnv)).toBe(secret);
  });

  it("treats an empty MYSTARS_WEBHOOK_SECRET as absent and falls back to --secret", () => {
    expect(resolveWebhookSecret(secret, { MYSTARS_WEBHOOK_SECRET: "" } as NodeJS.ProcessEnv)).toBe(secret);
  });

  it("throws when neither is provided", () => {
    expect(() => resolveWebhookSecret(undefined, {} as NodeJS.ProcessEnv)).toThrow();
  });
});
