/**
 * CLI command handlers — pure-ish functions that take a client + parsed options +
 * an IO sink, so they're unit-testable without spawning a process.
 */

import {
  buildPaymentRequest,
  verifyWebhookSignature,
  type Currency,
  type MyStarsClient,
  type OrderStatus,
  type OrderType,
} from "@mystars-tg/faas-sdk";

/**
 * The IO sink a command writes to — injected so commands are unit-testable
 * without touching the real process streams. The `mystars-faas` bin wires
 * `out` to stdout and `err` to stderr.
 */
export interface CliIO {
  /** Primary (machine-readable) output — pretty-printed JSON goes here. */
  out: (line: string) => void;
  /** Diagnostics / progress (e.g. status updates from `watch`) go here. */
  err: (line: string) => void;
}

function print(io: CliIO, value: unknown): void {
  io.out(JSON.stringify(value, null, 2));
}

/**
 * `pricing` — quote the all-in price for an item and print the `PricingQuote` JSON.
 *
 * @param client - a configured {@link MyStarsClient}
 * @param opts - `type` plus `quantity` (stars) or `months` (premium), and an optional `currency`
 * @param io - the output sink
 * @returns resolves once the quote has been printed
 * @throws `MyStarsValidationError` if `quantity`/`months` is out of range
 * @throws `MyStarsApiError` on an API failure (e.g. 503 when a price source is down)
 */
export async function cmdPricing(
  client: MyStarsClient,
  opts: { type: OrderType; quantity?: number; months?: number; currency?: Currency },
  io: CliIO,
): Promise<void> {
  const quote =
    opts.type === "stars"
      ? await client.getPricing({ type: "stars", quantity: opts.quantity!, payment_currency: opts.currency })
      : await client.getPricing({ type: "premium", months: opts.months!, payment_currency: opts.currency });
  print(io, quote);
}

/**
 * `products` — print the price-free product catalog (`GET /v1/products`).
 *
 * @param client - a configured {@link MyStarsClient}
 * @param io - the output sink
 * @returns resolves once the catalog has been printed
 * @throws `MyStarsApiError` on an API failure
 */
export async function cmdProducts(client: MyStarsClient, io: CliIO): Promise<void> {
  print(io, await client.listProducts());
}

/**
 * `currencies` — print the supported on-chain payment currencies (`GET /v1/currencies`).
 *
 * @param client - a configured {@link MyStarsClient}
 * @param io - the output sink
 * @returns resolves once the currency list has been printed
 * @throws `MyStarsApiError` on an API failure
 */
export async function cmdCurrencies(client: MyStarsClient, io: CliIO): Promise<void> {
  print(io, await client.listCurrencies());
}

/**
 * `recipient-check` — resolve a `@username` and print eligibility (`POST /v1/recipients/check`).
 *
 * @param client - a configured {@link MyStarsClient}
 * @param opts - `type`, the `username` (with or without a leading `@`), and `months` for premium
 * @param io - the output sink
 * @returns resolves once the result has been printed
 * @throws `MyStarsValidationError` if the username is malformed
 * @throws `MyStarsApiError` on an API failure
 */
export async function cmdRecipientCheck(
  client: MyStarsClient,
  opts: { type: OrderType; username: string; months?: number },
  io: CliIO,
): Promise<void> {
  const res =
    opts.type === "stars"
      ? await client.checkRecipient({ type: "stars", recipient: { username: opts.username } })
      : await client.checkRecipient({ type: "premium", recipient: { username: opts.username }, months: opts.months });
  print(io, res);
}

/**
 * `orders create` — create an order (`POST /v1/orders`) and print it. With
 * `pay: true` it also prints a non-custodial `payment_request` (deeplink / QR /
 * TON Connect) built from the order's payment block.
 *
 * NOTE: the CLI does not pass a stable idempotency key, so the client mints a
 * fresh uuid per invocation — fine for interactive one-offs, but for scripted /
 * automated creation prefer the SDK with a caller-stable `idempotencyKey`.
 *
 * @param client - a configured {@link MyStarsClient}
 * @param opts - `type`, `recipient` username, sizing (`quantity`/`months`), optional `currency`, `callback` URL, and `pay` to also emit a payment request
 * @param io - the output sink
 * @returns resolves once the order (and optional payment request) has been printed
 * @throws `MyStarsValidationError` if inputs are invalid
 * @throws `RecipientIneligibleError` (422) if the recipient cannot receive the item
 * @throws `MyStarsApiError` on any other API failure
 */
export async function cmdOrdersCreate(
  client: MyStarsClient,
  opts: {
    type: OrderType;
    recipient: string;
    quantity?: number;
    months?: number;
    currency?: Currency;
    callback?: string;
    pay?: boolean;
  },
  io: CliIO,
): Promise<void> {
  const order =
    opts.type === "stars"
      ? await client.createOrder({ type: "stars", recipient: { username: opts.recipient }, quantity: opts.quantity!, payment_currency: opts.currency, callback_url: opts.callback })
      : await client.createOrder({ type: "premium", recipient: { username: opts.recipient }, months: opts.months!, payment_currency: opts.currency, callback_url: opts.callback });
  if (opts.pay) {
    print(io, { order, payment_request: buildPaymentRequest(order.payment) });
  } else {
    print(io, order);
  }
}

/**
 * `orders get` — fetch one order by id (`GET /v1/orders/:id`) and print it.
 *
 * @param client - a configured {@link MyStarsClient}
 * @param id - the order UUID
 * @param io - the output sink
 * @returns resolves once the order has been printed
 * @throws `NotFoundError` (404) if no such order exists for this tenant
 * @throws `MyStarsApiError` on any other API failure
 */
export async function cmdOrdersGet(client: MyStarsClient, id: string, io: CliIO): Promise<void> {
  print(io, await client.getOrder(id));
}

/**
 * `orders list` — print a SINGLE page of orders (`GET /v1/orders`), optionally
 * filtered by `status`. (The CLI prints one page; use the SDK's `listOrders`
 * async iterator to walk every page.)
 *
 * @param client - a configured {@link MyStarsClient}
 * @param opts - optional `status` filter and `limit` (1-100, server default 50)
 * @param io - the output sink
 * @returns resolves once the page has been printed
 * @throws `MyStarsApiError` on an API failure
 */
export async function cmdOrdersList(
  client: MyStarsClient,
  opts: { status?: OrderStatus; limit?: number },
  io: CliIO,
): Promise<void> {
  const page = await client.listOrders(opts).page();
  print(io, page);
}

/**
 * `orders cancel` — cancel an `awaiting_payment` order (`POST /v1/orders/:id/cancel`) and print the result.
 *
 * @param client - a configured {@link MyStarsClient}
 * @param id - the order UUID
 * @param io - the output sink
 * @returns resolves once the cancel result has been printed
 * @throws `OrderNotCancellableError` (409) if the order is no longer `awaiting_payment`
 * @throws `MyStarsApiError` on any other API failure
 */
export async function cmdOrdersCancel(client: MyStarsClient, id: string, io: CliIO): Promise<void> {
  print(io, await client.cancelOrder(id));
}

/**
 * `watch` — poll an order until it reaches a terminal state, streaming each
 * status change to `io.err`, then print the final order to `io.out`.
 *
 * @param client - a configured {@link MyStarsClient}
 * @param id - the order UUID
 * @param io - the output sink (status updates → `err`, final order → `out`)
 * @returns resolves once the order is terminal and has been printed
 * @throws `OrderWaitTimeoutError` if the order does not finish before the default deadline
 * @throws `MyStarsApiError` on an API failure during polling
 */
export async function cmdWatch(client: MyStarsClient, id: string, io: CliIO): Promise<void> {
  const final = await client.waitForOrder(id, {
    onUpdate: (o) => io.err(`status: ${o.status}`),
  });
  print(io, final);
}

/**
 * Resolve the webhook secret. Prefers `MYSTARS_WEBHOOK_SECRET` over the `--secret`
 * flag: a secret on the command line leaks into the process list (`ps`) and shell
 * history, so the env var is the safe channel and wins when both are set. Throws
 * when neither is present.
 */
export function resolveWebhookSecret(
  optSecret: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  // `||` (not `??`) so an empty MYSTARS_WEBHOOK_SECRET="" falls back to --secret.
  const secret = env.MYSTARS_WEBHOOK_SECRET || optSecret;
  if (!secret) {
    throw new Error("a webhook secret is required (set MYSTARS_WEBHOOK_SECRET, or pass --secret <secret>)");
  }
  return secret;
}

/**
 * `webhook-verify` — verify an `X-Faas-Signature` over a raw webhook body and
 * print `{ valid: boolean }`. Does NOT need a client (offline HMAC check).
 *
 * @param opts - the tenant `secret`, the raw `body` string, and the `signature` header value
 * @param io - the output sink
 * @returns resolves once `{ valid }` has been printed (never throws on a bad signature — it prints `false`)
 */
export async function cmdWebhookVerify(
  opts: { secret: string; body: string; signature: string },
  io: CliIO,
): Promise<void> {
  const valid = await verifyWebhookSignature(opts.body, opts.signature, opts.secret);
  print(io, { valid });
}
