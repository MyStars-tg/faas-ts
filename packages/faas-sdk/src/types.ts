/**
 * Wire types for the MyStars FaaS `/v1` API.
 *
 * These mirror the JSON the server actually returns, field-for-field, in
 * `snake_case` — so they read identically to the REST docs. Money is always a
 * decimal string (never a `number`); convert to smallest units only at the
 * on-chain boundary.
 */

/** On-chain payment currency. Both settle on the TON chain. */
export type Currency = "ton" | "usdt_ton";

/** Orderable product type. */
export type OrderType = "stars" | "premium";

/** Which numeric parameter a product is sized by. */
export type Parameter = "quantity" | "months";

/** The full FaaS order status domain (15 values). */
export type OrderStatus =
  | "received"
  | "awaiting_payment"
  | "paid"
  | "reserved"
  | "swapping"
  | "funding"
  | "purchasing"
  | "fulfilling"
  | "completed"
  | "delivered"
  | "failed"
  | "reversed"
  | "expired"
  | "held"
  | "cancelled";

/** Statuses an order can never leave. */
export type TerminalStatus = "delivered" | "failed" | "reversed" | "expired" | "cancelled";

/** The terminal status set — an order in one of these will not change again. */
export const TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  "delivered",
  "failed",
  "reversed",
  "expired",
  "cancelled",
]);

/** True when an order has reached a final state. */
export function isTerminal(status: OrderStatus): status is TerminalStatus {
  return TERMINAL_STATUSES.has(status);
}

/** A reason a recipient cannot receive the item. */
export type RecipientCheckReason = "already_subscribed" | "not_found" | "ineligible";

/** A reason an order failed. */
export type FailureReason =
  | "underpaid"
  | "overpaid"
  | "no_memo"
  | "wrong_memo"
  | "undeliverable"
  | "expired"
  | (string & {});

/** One supported payment currency, from `GET /v1/currencies`. */
export interface CurrencyInfo {
  code: Currency;
  chain: string;
  name: string;
}

/** One product from the catalog, from `GET /v1/products`. */
export interface Product {
  type: OrderType;
  name: string;
  parameter: Parameter;
  min: number;
  max: number;
  /** A fixed allowed set (e.g. premium months `[3,6,12]`), or `null` for a continuous range. */
  values: number[] | null;
}

/**
 * The USDT processing-fee itemization (present only for `usdt_ton`).
 *
 * Invariant: `subtotal + processing_fee === total === amount`. This is an
 * itemization of the fee already inside `amount` — never an additional charge.
 * All fields are decimal USDT strings.
 */
export interface FeeBreakdown {
  subtotal: string;
  processing_fee: string;
  total: string;
  description: string;
  currency: "usdt";
}

/** A price quote from `GET /v1/pricing`. */
export interface PricingQuote {
  type: OrderType;
  quantity: number | null;
  months: number | null;
  /** All-in total to pay, in `currency`, as a decimal string. */
  amount: string;
  currency: Currency;
  /** Itemized fee for `usdt_ton`; `null` for `ton`. */
  fee: FeeBreakdown | null;
  /** Informational market rate; `null` if the cache is cold. */
  usdt_per_ton: string | null;
  quoted_at: string;
  /** A re-quote hint (`quoted_at + ttl`) — NOT a price lock. Price is fixed at order creation. */
  valid_until: string;
}

/** The result of `POST /v1/recipients/check`. */
export interface RecipientCheck {
  resolved: boolean;
  eligible: boolean;
  recipient_name: string | null;
  reason: RecipientCheckReason | null;
  /** Verbatim Telegram/Fragment rejection text; `null` when eligible. */
  telegram_message: string | null;
}

/** The on-chain payment instruction attached to a created order. */
export interface PaymentInstruction {
  currency: Currency;
  chain: "ton";
  /** The treasury OWNER address — the same for both `ton` and `usdt_ton`. */
  pay_to_address: string | null;
  /** The bare order UUID, attached as the on-chain text comment (no `STARS:` prefix). */
  memo: string | null;
  /** The exact amount to send, as a decimal string. */
  amount: string;
  amount_units: "ton" | "usdt";
  /** Itemized fee for `usdt_ton`; `null` for `ton`. */
  fee: FeeBreakdown | null;
}

/** The full order resource, from `GET /v1/orders` and `GET /v1/orders/:id`. */
export interface Order {
  order_id: string;
  status: OrderStatus;
  type: OrderType;
  recipient_username: string | null;
  quantity: number | null;
  months: number | null;
  amount_ton: string | null;
  payment_tx: string | null;
  purchase_tx: string | null;
  failure_reason: FailureReason | null;
  reversal_tx: string | null;
  telegram_message: string | null;
  created_at: string;
  updated_at: string;
  /** Non-null only while `status === "awaiting_payment"`. */
  expires_at: string | null;
}

/** The result of `POST /v1/orders` (201 new, or 200 idempotent replay). */
export interface CreateOrderResult {
  order_id: string;
  /**
   * A fresh 201 create is always `awaiting_payment`. A 200 idempotent replay
   * (same `Idempotency-Key`, same body) echoes the order's CURRENT status, which
   * may already have advanced (e.g. `paid`, `delivered`) — so narrow against the
   * full status domain, not the literal.
   */
  status: OrderStatus;
  type: OrderType;
  quantity: number | null;
  months: number | null;
  payment: PaymentInstruction;
  expires_at: string;
  /** `true` when the server returned 200 (idempotent replay) rather than 201 (fresh create). */
  replayed: boolean;
}

/** One page of orders from `GET /v1/orders`. */
export interface OrdersPage {
  orders: Order[];
  /** Opaque keyset cursor for the next page, or `null` on the final page. */
  next_cursor: string | null;
}

/** The terminal statuses that fire a webhook (NOT `cancelled`, which is a manual API action). */
export type WebhookStatus = "delivered" | "failed" | "reversed" | "expired";

/**
 * The terminal statuses that fire an order webhook — `delivered`/`failed`/
 * `reversed`/`expired` (NOT `cancelled`, which is a manual API action and never
 * webhooked). Mirrors `webhook_terminal` in the contract status-machine fixture.
 */
export const WEBHOOK_TERMINAL: ReadonlySet<WebhookStatus> = new Set<WebhookStatus>([
  "delivered",
  "failed",
  "reversed",
  "expired",
]);

/** The status an order is in immediately after a fresh `POST /v1/orders` (201). */
export const INITIAL_ORDER_STATUS: OrderStatus = "awaiting_payment";

/** Statuses an order can be cancelled from via `POST /v1/orders/:id/cancel`. */
export const CANCELLABLE_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>(["awaiting_payment"]);

/**
 * The body of an order webhook (POSTed to your `callback_url`). Deliberately
 * minimal — fetch `GET /v1/orders/:id` for full detail. Treat every field beyond
 * `order_id`/`status` as optional.
 */
export interface WebhookEvent {
  order_id: string;
  status: WebhookStatus;
  failure_reason?: FailureReason;
  purchase_tx?: string;
}
