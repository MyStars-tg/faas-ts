/**
 * `MyStarsClient` — the typed entry point to the MyStars FaaS API.
 *
 * Wraps the 8 public `/v1` endpoints with typed requests/responses, automatic
 * retries (honoring `Retry-After`), automatic `Idempotency-Key` generation +
 * safe reuse on retry, keyset pagination, and order tracking.
 */

import { MyStarsApiError } from "./errors.js";
import { Transport, type Interceptors } from "./http/transport.js";
import { resolveRetryPolicy, type RetryPolicy } from "./http/retry.js";
import { defaultSleep } from "./internal/sleep.js";
import { uuidv4 } from "./internal/uuid.js";
import {
  assertOrderType,
  assertPremiumMonths,
  assertStarsQuantity,
  canonicalUsername,
} from "./internal/validate.js";
import { OrdersPager } from "./tracking/pager.js";
import { reconcile, type ReconcileOptions } from "./tracking/reconcile.js";
import { waitForOrder, type WaitForOrderOptions } from "./tracking/waitForOrder.js";
import { SDK_VERSION } from "./version.js";
import type {
  CreateOrderResult,
  Currency,
  CurrencyInfo,
  Order,
  OrdersPage,
  OrderStatus,
  PricingQuote,
  Product,
  RecipientCheck,
} from "./types.js";

/** Base URL of the production B2B edge (`api.mystars.tg`). */
export const PRODUCTION_BASE_URL = "https://api.mystars.tg/v1";

/** Configuration for {@link MyStarsClient}. Only `apiKey` is required. */
export interface MyStarsClientOptions {
  /** Your tenant API key (`faas_…`). Sent as the `X-Api-Key` header. */
  apiKey: string;
  /** Full base URL incl. `/v1`. Defaults to production (`api.mystars.tg`). */
  baseUrl?: string;
  /** Injected fetch. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Per-request timeout in ms. Default 30_000. */
  timeoutMs?: number;
  /** Retry policy, or `false` to disable retries. */
  retry?: RetryPolicy | false;
  /** Generates the `Idempotency-Key` for `createOrder` when the caller omits one. Default uuid v4. */
  idempotencyKeyFactory?: () => string;
  /** Sent as `User-Agent` (Node only; browsers ignore it). */
  userAgent?: string;
  /** Observability hooks. Never receive the API key. */
  interceptors?: Interceptors;
  /** Test injectables. */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

/** Per-call options common to every request — currently just an `AbortSignal`. */
export interface RequestOptions {
  signal?: AbortSignal;
}

/** Options for {@link MyStarsClient.createOrder} — a {@link RequestOptions} plus an optional stable key. */
export interface CreateOrderOptions extends RequestOptions {
  /** Reuse a specific idempotency key (e.g. derived from your own order id). */
  idempotencyKey?: string;
}

/** Discriminated input for {@link MyStarsClient.getPricing} — sized by `quantity` (stars) or `months` (premium). */
export type PricingParams =
  | { type: "stars"; quantity: number; payment_currency?: Currency }
  | { type: "premium"; months: number; payment_currency?: Currency };

/** Discriminated input for {@link MyStarsClient.checkRecipient} (premium may include the intended `months`). */
export type CheckRecipientParams =
  | { type: "stars"; recipient: { username: string } }
  | { type: "premium"; recipient: { username: string }; months?: number };

/** Discriminated input for {@link MyStarsClient.createOrder} — recipient + sizing + optional currency/callback. */
export type CreateOrderParams =
  | {
      type: "stars";
      recipient: { username: string };
      quantity: number;
      payment_currency?: Currency;
      callback_url?: string;
    }
  | {
      type: "premium";
      recipient: { username: string };
      months: number;
      payment_currency?: Currency;
      callback_url?: string;
    };

/** Filters for {@link MyStarsClient.listOrders} — status, page size, and a starting cursor. */
export interface ListOrdersParams {
  status?: OrderStatus;
  /** 1-100; the server caps at 100 and defaults to 50. */
  limit?: number;
  cursor?: string;
}

function resolveBaseUrl(opts: MyStarsClientOptions): string {
  return opts.baseUrl ?? PRODUCTION_BASE_URL;
}

/** The typed entry point to the MyStars FaaS `/v1` API. See the module overview for the full flow. */
export class MyStarsClient {
  private readonly transport: Transport;
  private readonly idempotencyKeyFactory: () => string;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;

  /**
   * @param opts - the {@link MyStarsClientOptions} (at minimum `apiKey`). Prefer the
   *   {@link MyStarsClient.production} factory.
   * @throws `Error` if `apiKey` is missing, or no `fetch` is available (Node <18 — pass `fetch` explicitly)
   */
  constructor(opts: MyStarsClientOptions) {
    if (!opts.apiKey) throw new Error("MyStarsClient: `apiKey` is required");
    const fetchImpl = opts.fetch ?? (globalThis.fetch ? globalThis.fetch.bind(globalThis) : undefined);
    if (!fetchImpl) {
      throw new Error("MyStarsClient: no global fetch found — pass `fetch` explicitly (Node <18 or a custom runtime)");
    }
    this.idempotencyKeyFactory = opts.idempotencyKeyFactory ?? uuidv4;
    this.now = opts.now ?? (() => Date.now());
    this.random = opts.random ?? Math.random;
    // Abortable sleep (shared with the transport) so an AbortSignal cuts a
    // waitForOrder() poll-wait short instead of waiting out the interval.
    this.sleep = opts.sleep ?? defaultSleep;
    this.transport = new Transport({
      apiKey: opts.apiKey,
      baseUrl: resolveBaseUrl(opts),
      fetchImpl,
      timeoutMs: opts.timeoutMs ?? 30_000,
      retry: resolveRetryPolicy(opts.retry),
      userAgent: opts.userAgent ?? `mystars-faas-sdk/${SDK_VERSION}`,
      interceptors: opts.interceptors,
      sleep: opts.sleep,
      random: opts.random,
    });
  }

  /**
   * Build a client pointed at production (`api.mystars.tg`).
   *
   * @param apiKey - your tenant `faas_…` API key
   * @param opts - any other {@link MyStarsClientOptions} except `apiKey`/`baseUrl`
   * @returns a configured client
   * @example
   * ```ts
   * const client = MyStarsClient.production(process.env.MYSTARS_API_KEY!);
   * ```
   */
  static production(apiKey: string, opts?: Omit<MyStarsClientOptions, "apiKey" | "baseUrl">): MyStarsClient {
    return new MyStarsClient({ ...opts, apiKey });
  }

  /**
   * `GET /v1/currencies` — the supported on-chain payment currencies.
   *
   * @param opts - optional `signal` to abort the request
   * @returns the supported {@link CurrencyInfo} list
   * @throws `MyStarsApiError` on an API/network failure
   */
  async listCurrencies(opts: RequestOptions = {}): Promise<CurrencyInfo[]> {
    const { data } = await this.transport.request<{ currencies: CurrencyInfo[] }>({
      method: "GET",
      path: "/currencies",
      signal: opts.signal,
    });
    return data.currencies;
  }

  /**
   * `GET /v1/products` — the orderable product catalog (price-free).
   *
   * @param opts - optional `signal` to abort the request
   * @returns the {@link Product} catalog (buyable shapes + limits)
   * @throws `MyStarsApiError` on an API/network failure
   */
  async listProducts(opts: RequestOptions = {}): Promise<Product[]> {
    const { data } = await this.transport.request<{ products: Product[] }>({
      method: "GET",
      path: "/products",
      signal: opts.signal,
    });
    return data.products;
  }

  /**
   * `GET /v1/pricing` — quote the all-in price for an item. Probe-rate-limited (30/min).
   *
   * @param params - `{ type, quantity | months, payment_currency? }`; `payment_currency` defaults server-side
   * @param opts - optional `signal` to abort the request
   * @returns the {@link PricingQuote} — `amount` is the all-in total in `currency`; `fee` is itemized for `usdt_ton`
   * @throws `MyStarsValidationError` if `quantity`/`months` is out of range
   * @throws `RateLimitError` (429) if the probe limit is exceeded
   * @throws `ServiceUnavailableError` (503) if a price source is temporarily down
   * @example
   * ```ts
   * const q = await client.getPricing({ type: "stars", quantity: 500, payment_currency: "ton" });
   * console.log(`pay ${q.amount} ${q.currency}`);
   * ```
   */
  async getPricing(params: PricingParams, opts: RequestOptions = {}): Promise<PricingQuote> {
    assertOrderType(params.type);
    const query: Record<string, string | number | undefined> = {
      type: params.type,
      payment_currency: params.payment_currency,
    };
    if (params.type === "stars") {
      assertStarsQuantity(params.quantity);
      query.quantity = params.quantity;
    } else {
      assertPremiumMonths(params.months);
      query.months = params.months;
    }
    const { data } = await this.transport.request<PricingQuote>({
      method: "GET",
      path: "/pricing",
      query,
      signal: opts.signal,
    });
    return data;
  }

  /**
   * `POST /v1/recipients/check` — resolve a `@username` and check eligibility before ordering.
   *
   * @param params - `{ type, recipient: { username }, months? }`; the username is canonicalized (strip `@`, lowercase)
   * @param opts - optional `signal` to abort the request
   * @returns the {@link RecipientCheck} — `resolved`/`eligible`, the display `recipient_name`, and a `reason` when ineligible
   * @throws `MyStarsValidationError` if the username is malformed
   * @throws `MyStarsApiError` on an API/network failure
   */
  async checkRecipient(params: CheckRecipientParams, opts: RequestOptions = {}): Promise<RecipientCheck> {
    assertOrderType(params.type);
    const body: Record<string, unknown> = {
      type: params.type,
      recipient: { username: canonicalUsername(params.recipient.username) },
    };
    if (params.type === "premium" && params.months !== undefined) {
      assertPremiumMonths(params.months);
      body.months = params.months;
    }
    const { data } = await this.transport.request<RecipientCheck>({
      method: "POST",
      path: "/recipients/check",
      body,
      // Read-only and fail-open server-side, so safe to retry on transient errors.
      idempotent: true,
      signal: opts.signal,
    });
    return data;
  }

  /**
   * `POST /v1/orders` — create an order. An `Idempotency-Key` is sent once and
   * reused across this call's retries, so a retried create returns the idempotent
   * replay (`replayed: true`) instead of a duplicate.
   *
   * MONEY SAFETY — supply a STABLE key derived from YOUR OWN order id
   * (`{ idempotencyKey: \`order-\${myOrderId}\` }`). The auto-generated uuid only
   * dedupes WITHIN a single `createOrder` call's internal retries; a brand-new
   * call (e.g. your process crashed and re-ran) mints a fresh uuid and can create
   * a SECOND order for the same intent. A caller-stable key makes the create
   * idempotent across process restarts and at-least-once job runners.
   *
   * On failure the thrown {@link MyStarsApiError} carries the `idempotencyKey`
   * that was used — when you can't tell whether the order was created
   * server-side, retry with that exact key (`{ idempotencyKey: err.idempotencyKey }`)
   * to get the idempotent replay rather than a duplicate.
   *
   * @param params - `{ type, recipient: { username }, quantity | months, payment_currency?, callback_url? }`
   * @param opts - optional caller-stable `idempotencyKey` (recommended) and `signal`
   * @returns the {@link CreateOrderResult} — `payment` instruction + `expires_at`; `replayed` is `true` on a 200 idempotent replay
   * @throws `MyStarsValidationError` if inputs are invalid
   * @throws `RecipientIneligibleError` (422) if the recipient cannot receive the item (no order created)
   * @throws `IdempotencyConflictError` (409) if the same key is reused with a different body
   * @throws `MyStarsApiError` on any other API failure (carries the `idempotencyKey` for safe retry)
   * @example
   * ```ts
   * const order = await client.createOrder(
   *   { type: "stars", recipient: { username: "durov" }, quantity: 100 },
   *   { idempotencyKey: `order-${myOrderId}` },
   * );
   * // pay order.payment.amount → order.payment.pay_to_address, comment = order.payment.memo
   * ```
   */
  async createOrder(params: CreateOrderParams, opts: CreateOrderOptions = {}): Promise<CreateOrderResult> {
    assertOrderType(params.type);
    const body: Record<string, unknown> = {
      type: params.type,
      recipient: { username: canonicalUsername(params.recipient.username) },
    };
    if (params.type === "stars") {
      assertStarsQuantity(params.quantity);
      body.quantity = params.quantity;
    } else {
      assertPremiumMonths(params.months);
      body.months = params.months;
    }
    if (params.payment_currency !== undefined) body.payment_currency = params.payment_currency;
    if (params.callback_url !== undefined) body.callback_url = params.callback_url;

    const idempotencyKey = opts.idempotencyKey ?? this.idempotencyKeyFactory();
    try {
      const { data, status } = await this.transport.request<Omit<CreateOrderResult, "replayed">>({
        method: "POST",
        path: "/orders",
        body,
        idempotencyKey,
        signal: opts.signal,
      });
      return { ...data, replayed: status === 200 };
    } catch (err) {
      // Surface the key that was used so the caller can retry it safely (no duplicate).
      if (err instanceof MyStarsApiError && err.idempotencyKey === undefined) {
        (err as { idempotencyKey?: string }).idempotencyKey = idempotencyKey;
      }
      throw err;
    }
  }

  /**
   * `GET /v1/orders/:id` — fetch one order (tenant-scoped). Polling an
   * `awaiting_payment` order also nudges the server's on-demand payment detection.
   *
   * @param orderId - the order UUID
   * @param opts - optional `signal` to abort the request
   * @returns the {@link Order}
   * @throws `NotFoundError` (404) if no such order exists for this tenant
   * @throws `MyStarsApiError` on any other API failure
   */
  async getOrder(orderId: string, opts: RequestOptions = {}): Promise<Order> {
    const { data } = await this.transport.request<Order>({
      method: "GET",
      path: `/orders/${encodeURIComponent(orderId)}`,
      signal: opts.signal,
    });
    return data;
  }

  /**
   * `POST /v1/orders/:id/cancel` — cancel an `awaiting_payment` order.
   *
   * @param orderId - the order UUID
   * @param opts - optional `signal` to abort the request
   * @returns `{ order_id, status: "cancelled" }`
   * @throws `OrderNotCancellableError` (409) if the order is no longer `awaiting_payment` (a retry after a lost success can also surface this even though the cancel committed — re-check with `getOrder`)
   * @throws `MyStarsApiError` on any other API failure
   */
  async cancelOrder(orderId: string, opts: RequestOptions = {}): Promise<{ order_id: string; status: "cancelled" }> {
    const { data } = await this.transport.request<{ order_id: string; status: "cancelled" }>({
      method: "POST",
      path: `/orders/${encodeURIComponent(orderId)}/cancel`,
      // Safe to retry: the cancel is a guarded transition (no double-action). Note a
      // retry after a lost success can surface OrderNotCancellableError (409) even
      // though the cancel committed — re-check with getOrder() if you catch one.
      idempotent: true,
      signal: opts.signal,
    });
    return data;
  }

  private listOrdersPage(params: ListOrdersParams, cursor: string | undefined, signal?: AbortSignal): Promise<OrdersPage> {
    return this.transport
      .request<OrdersPage>({
        method: "GET",
        path: "/orders",
        query: { status: params.status, limit: params.limit, cursor },
        signal,
      })
      .then((r) => r.data);
  }

  /**
   * `GET /v1/orders` — an auto-paginating view: `for await (const order of client.listOrders())`.
   * The pager owns the cursor; `params.cursor` (if given) is the starting page.
   *
   * @param params - optional `status` filter, `limit` (1-100), and a starting `cursor`
   * @param opts - optional `signal` to abort the underlying page fetches
   * @returns an {@link OrdersPager} (async-iterable; `.pages()` / `.page()` / `.all()`)
   * @example
   * ```ts
   * for await (const order of client.listOrders({ status: "delivered" })) {
   *   console.log(order.order_id);
   * }
   * ```
   */
  listOrders(params: ListOrdersParams = {}, opts: RequestOptions = {}): OrdersPager {
    return new OrdersPager((cursor) => this.listOrdersPage(params, cursor, opts.signal), params.cursor);
  }

  /**
   * Poll `GET /v1/orders/:id` until the order is terminal (or the deadline).
   *
   * @param orderId - the order UUID
   * @param options - the {@link WaitForOrderOptions} (intervals, deadline, `until`, `onUpdate`, `signal`)
   * @returns the final {@link Order} once terminal
   * @throws `OrderWaitTimeoutError` if `maxWaitMs` elapses first (carries the last snapshot)
   * @throws `MyStarsApiError` if a poll fails non-transiently
   * @example
   * ```ts
   * const final = await client.waitForOrder(order.order_id, { onUpdate: (o) => console.log(o.status) });
   * ```
   */
  waitForOrder(orderId: string, options: WaitForOrderOptions = {}): Promise<Order> {
    return waitForOrder(orderId, options, {
      getOrder: (id, o) => this.getOrder(id, o),
      sleep: this.sleep,
      now: this.now,
      random: this.random,
    });
  }

  /**
   * Diff the server's orders against your local store to catch webhook-missed terminal transitions.
   *
   * @param options - the {@link ReconcileOptions}; `isKnown` is required, `since` bounds the scan
   * @returns the missed terminal {@link Order}s, newest-first
   * @throws `MyStarsApiError` if a page fetch fails
   */
  reconcile(options: ReconcileOptions): Promise<Order[]> {
    return reconcile(this, options);
  }
}
