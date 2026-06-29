/**
 * `fulfill()` — the one-call convenience: create an order, pay it from your
 * wallet, and wait until it's delivered (or failed/reversed/expired).
 *
 * RETRY HAZARD (money): this broadcasts a REAL payment. A naive retry of a
 * `fulfill` that already broadcast would create a SECOND order and pay it AGAIN.
 * Two safeguards make retries safe:
 *   1. A stable `idempotencyKey` is REQUIRED — re-running `fulfill` with the same
 *      key returns the SAME order from the server (idempotent replay) instead of
 *      minting a duplicate.
 *   2. We only broadcast when the (possibly replayed) order is still
 *      `awaiting_payment`. If the replay shows the order already advanced
 *      (`paid`/`delivered`/…), we SKIP the payment and just wait — so a retry
 *      never double-pays an order whose first payment already landed.
 * If anything throws after the order exists, the error carries `order_id` so you
 * re-attach via `getOrder`/`waitForOrder` instead of re-paying.
 */

import {
  MyStarsValidationError,
  type CreateOrderOptions,
  type CreateOrderParams,
  type CreateOrderResult,
  type Order,
  type WaitForOrderOptions,
} from "@mystars-tg/faas-sdk";
import { OrderPayer, type PayOrderOptions } from "./payer.js";
import type { TonWallet } from "./wallet.js";

/** The slice of `MyStarsClient` `fulfill` needs (structurally typed so it's easy to mock). */
export interface FulfillClient {
  createOrder(params: CreateOrderParams, opts?: CreateOrderOptions): Promise<CreateOrderResult>;
  waitForOrder(orderId: string, opts?: WaitForOrderOptions): Promise<Order>;
}

/** Options for {@link fulfill} — the {@link PayOrderOptions} (e.g. `rpc`) plus order-create/wait wiring. */
export interface FulfillOptions extends PayOrderOptions {
  /**
   * REQUIRED stable idempotency key — derive it from YOUR OWN order id so a retry
   * of `fulfill` reuses the same key and the server returns the same order instead
   * of creating a duplicate. May also be supplied via `createOptions.idempotencyKey`.
   */
  idempotencyKey?: string;
  /** Options forwarded to `createOrder` (e.g. a caller-supplied idempotency key). */
  createOptions?: CreateOrderOptions;
  /** Options forwarded to `waitForOrder`. */
  wait?: WaitForOrderOptions;
}

/**
 * An error thrown AFTER the order was created carries the `order_id` so you can
 * re-attach (`getOrder`/`waitForOrder`) instead of re-running `fulfill` (which
 * would re-pay). The error may be any class (a `MyStarsApiError` from the wait, a
 * `WalletError` from the payer, …), so the id rides as an optional property —
 * read it with the type-safe {@link orderIdFromError} accessor.
 */
export type ErrorWithOrderId = Error & { order_id?: string };

/** Attach the `order_id` to a post-create error so the caller can re-attach (not re-pay). */
function withOrderId(err: unknown, orderId: string): unknown {
  if (err && typeof err === "object" && (err as { order_id?: unknown }).order_id === undefined) {
    try {
      (err as { order_id?: string }).order_id = orderId;
    } catch {
      // frozen/sealed error — nothing we can do; surface it as-is.
    }
  }
  return err;
}

/**
 * Read the `order_id` that `fulfill` attaches to a post-create failure. Returns
 * `undefined` when the error carries none. Use it to recover safely after a
 * `fulfill` throw — re-attach with `client.waitForOrder(id)` / `getOrder(id)`
 * rather than re-running `fulfill` (which would broadcast a second payment).
 */
export function orderIdFromError(err: unknown): string | undefined {
  if (err && typeof err === "object") {
    const id = (err as { order_id?: unknown }).order_id;
    if (typeof id === "string") return id;
  }
  return undefined;
}

/**
 * create → pay → wait-until-terminal, in one call.
 *
 * Creates the order with the required stable `idempotencyKey`, broadcasts the
 * payment from `wallet` ONLY if the (possibly idempotent-replayed) order is still
 * `awaiting_payment`, then polls until the order is terminal. See the module note
 * for the money-retry safeguards.
 *
 * @param client - the order-layer client (a `MyStarsClient`, or any {@link FulfillClient})
 * @param wallet - the funded {@link TonWallet} that pays the invoice
 * @param params - the order to create (`CreateOrderParams`)
 * @param opts - {@link FulfillOptions} — MUST include a stable `idempotencyKey` (or `createOptions.idempotencyKey`) plus `rpc`
 * @returns the final {@link Order} (terminal status — `delivered`/`failed`/`reversed`/`expired`)
 * @throws `MyStarsValidationError` if no stable `idempotencyKey` was supplied
 * @throws `RecipientIneligibleError` (422) if the recipient cannot receive the item (no order created)
 * @throws `InsufficientBalanceError` if the wallet can't cover the payment
 * @throws `OrderWaitTimeoutError` if the order doesn't finish before the wait deadline
 * @throws `MyStarsApiError` on other API failures — after the order exists the thrown error carries `order_id` (read via {@link orderIdFromError}); re-attach with `client.waitForOrder(orderId)` instead of re-running `fulfill`
 * @example
 * ```ts
 * const order = await fulfill(
 *   client, wallet,
 *   { type: "stars", recipient: { username: "durov" }, quantity: 100 },
 *   { rpc, idempotencyKey: `order-${myOrderId}` },
 * );
 * if (order.status !== "delivered") console.warn("not delivered:", order.failure_reason);
 * ```
 */
export async function fulfill(
  client: FulfillClient,
  wallet: TonWallet,
  params: CreateOrderParams,
  opts: FulfillOptions,
): Promise<Order> {
  const idempotencyKey = opts.idempotencyKey ?? opts.createOptions?.idempotencyKey;
  if (!idempotencyKey) {
    throw new MyStarsValidationError(
      "fulfill() requires a stable idempotencyKey (opts.idempotencyKey or createOptions.idempotencyKey), " +
        "derived from your own order id — without it a retry would create a duplicate order and broadcast a second payment",
    );
  }
  const createOptions: CreateOrderOptions = { ...opts.createOptions, idempotencyKey };

  const order = await client.createOrder(params, createOptions);
  try {
    // Only broadcast when the order still needs payment. A retry that gets an
    // idempotent replay already past awaiting_payment must NOT pay again.
    if (order.status === "awaiting_payment") {
      await new OrderPayer(wallet).payOrder(order, opts);
    }
  } catch (err) {
    throw withOrderId(err, order.order_id);
  }
  try {
    return await client.waitForOrder(order.order_id, opts.wait);
  } catch (err) {
    throw withOrderId(err, order.order_id);
  }
}
