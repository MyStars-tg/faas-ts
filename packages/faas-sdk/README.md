# @mystars-tg/faas-sdk

[![npm](https://img.shields.io/npm/v/@mystars-tg/faas-sdk.svg)](https://www.npmjs.com/package/@mystars-tg/faas-sdk) [![license](https://img.shields.io/npm/l/@mystars-tg/faas-sdk.svg)](LICENSE) [![API contract](https://img.shields.io/badge/FaaS%20API-v1.9.0-blue.svg)](https://mystars.tg/docs)

Official TypeScript/JavaScript SDK for the **MyStars FaaS** API — buy Telegram **Stars** &
**Premium** for any `@username`, paid in **TON** or **USDT (TON)**.

Works in Node ≥18, Deno, Bun, Cloudflare Workers, and the browser (the core has **zero crypto
dependencies**). The opt-in wallet module (`@mystars-tg/faas-wallet`) and CLI (`@mystars-tg/faas-cli`) ship
separately.

> Compatible with FaaS API **v1.9.0**.

📖 Full interactive API reference: **[mystars.tg/docs](https://mystars.tg/docs)**.

## Install

```bash
npm install @mystars-tg/faas-sdk
```

## Get an API key

Keys are issued inside the MyStars Telegram bot — open [@my_stars_tg_bot](https://t.me/my_stars_tg_bot),
tap **API access**, and copy your `X-Api-Key`. No dashboard, no signup form.

## Quick start

```ts
import { MyStarsClient } from "@mystars-tg/faas-sdk";

const client = MyStarsClient.production(process.env.MYSTARS_API_KEY!);

// 1. Quote the price
const quote = await client.getPricing({ type: "stars", quantity: 100, payment_currency: "ton" });
console.log(`Pay ${quote.amount} ${quote.currency}`);

// 2. (optional) Check the recipient first
const check = await client.checkRecipient({ type: "stars", recipient: { username: "durov" } });
if (!check.eligible) throw new Error(check.telegram_message ?? "recipient ineligible");

// 3. Create the order. Pass a STABLE idempotencyKey derived from your own order id
//    so a retry (even after a crash) returns the SAME order instead of a duplicate.
//    Omit it and the SDK auto-generates a uuid that only dedupes within ONE call's retries.
const order = await client.createOrder(
  {
    type: "stars",
    recipient: { username: "durov" },
    quantity: 100,
    payment_currency: "ton",
    callback_url: "https://your-app.example.com/webhooks/mystars",
  },
  { idempotencyKey: `order-${myOrderId}` },
);

// 4. Pay it: send order.payment.amount to order.payment.pay_to_address
//    with the on-chain comment order.payment.memo (the bare order UUID).
console.log(order.payment);

// 5. Track it until it's delivered (or failed/reversed/expired)
const finished = await client.waitForOrder(order.order_id, {
  onUpdate: (o) => console.log("status:", o.status),
});
console.log("done:", finished.status, finished.purchase_tx);
```

> Set `MYSTARS_API_KEY` in your environment before running, or load a `.env` with Node's built-in
> flag — `node --env-file=.env app.js` (no extra dependency). Snippets use illustrative placeholders
> (`myOrderId`, `WEBHOOK_SECRET`, `rawBody`, `req`/`express`, …) — substitute your own values.

## Errors

Every failure is a typed subclass of `MyStarsApiError` (itself a `MyStarsError`):

```ts
import { RecipientIneligibleError, RateLimitError } from "@mystars-tg/faas-sdk";

try {
  await client.createOrder({ type: "premium", recipient: { username: "durov" }, months: 3 });
} catch (err) {
  if (err instanceof RecipientIneligibleError) {
    // err.telegramMessage: the buyer-facing reason to show your user.
    // For the structured reason ("already_subscribed" | "not_found" | "ineligible"),
    // call client.checkRecipient(...) first and read its `reason`.
  } else if (err instanceof RateLimitError) {
    // err.retryAfterMs, err.kind: "general" | "order_cap"
  }
}
```

The client retries transient failures (network, timeout, 502/503/504, 500, and the general 429 —
honoring `Retry-After`, capped at `maxDelayMs`) automatically and idempotency-safely. Configure or
disable via the `retry` option.

### Recovering a `createOrder` that failed

When `createOrder` throws you can't always tell whether the order was created server-side. The thrown
`MyStarsApiError` carries the `idempotencyKey` that was used — retry with that exact key to get the
idempotent replay instead of a duplicate deliverable:

```ts
try {
  await client.createOrder(params, { idempotencyKey: `order-${myOrderId}` });
} catch (err) {
  if (err instanceof MyStarsApiError && err.idempotencyKey) {
    // Safe: same key → server returns the original order (replayed:true), never a 2nd order.
    await client.createOrder(params, { idempotencyKey: err.idempotencyKey });
  }
}
```

## Pagination

```ts
// Auto-paginate every order:
for await (const order of client.listOrders({ status: "delivered" })) {
  console.log(order.order_id);
}

// Or page-by-page:
const pager = client.listOrders({ limit: 100 });
const first = await pager.page();
const next = first.next_cursor ? await pager.page(first.next_cursor) : null;
```

## Reference

| Method | Endpoint |
|---|---|
| `listCurrencies()` | `GET /v1/currencies` |
| `listProducts()` | `GET /v1/products` |
| `getPricing(params)` | `GET /v1/pricing` |
| `checkRecipient(params)` | `POST /v1/recipients/check` |
| `createOrder(params, opts?)` | `POST /v1/orders` |
| `listOrders(params?)` | `GET /v1/orders` |
| `getOrder(id)` | `GET /v1/orders/:id` |
| `cancelOrder(id)` | `POST /v1/orders/:id/cancel` |
| `waitForOrder(id, opts?)` | polls `GET /v1/orders/:id` |
| `reconcile(opts)` | diffs `listOrders` vs your store to catch webhook-missed terminal transitions |

## Webhooks

```ts
import { constructEvent, expressWebhook } from "@mystars-tg/faas-sdk";

// Verify manually (verify over the RAW body, then dedup on order_id):
const event = await constructEvent(rawBody, req.headers["x-faas-signature"], WEBHOOK_SECRET);

// Or use the Express adapter (mount express.raw() on the route):
app.post("/webhooks/mystars", express.raw({ type: "*/*" }), expressWebhook({
  secret: WEBHOOK_SECRET,
  onEvent: async (event) => { /* event.order_id, event.status, event.purchase_tx */ },
}));
```

`verifyWebhookSignature` / `constructEvent` handle the 24h secret-rotation header
(`"current,previous"`) automatically. A `fastifyWebhook` adapter is also exported.

## Your own retail markup

```ts
import { applyRetailMarkup } from "@mystars-tg/faas-sdk";

const quote = await client.getPricing({ type: "stars", quantity: 100, payment_currency: "usdt_ton" });
const retail = applyRetailMarkup(quote, { marginPct: 15, passThroughProcessingFee: true });
// retail.total → what to charge your customer; retail.profit → your gross margin.
```

Uses the exact two-stage cent-ceil the server uses, so your retail math never drifts a cent.

## Pay an order (non-custodial)

```ts
import { buildPaymentRequest } from "@mystars-tg/faas-sdk";

const req = buildPaymentRequest(order.payment);
// req.tonDeeplink / req.qrPayload (TON), or req.tonConnect for tonConnectUI.sendTransaction({ messages })
```

Holds no keys. For wallet generation + signing/broadcasting from your own wallet, see
[`@mystars-tg/faas-wallet`](https://www.npmjs.com/package/@mystars-tg/faas-wallet).
