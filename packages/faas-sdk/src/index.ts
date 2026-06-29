/**
 * @mystars-tg/faas-sdk — official TypeScript SDK for the MyStars FaaS API.
 *
 * Buy Telegram Stars & Premium for any @username, paid in TON or USDT.
 *
 * @example
 * ```ts
 * import { MyStarsClient } from "@mystars-tg/faas-sdk";
 *
 * const client = MyStarsClient.production(process.env.MYSTARS_API_KEY!);
 *
 * const quote = await client.getPricing({ type: "stars", quantity: 100, payment_currency: "ton" });
 * const order = await client.createOrder({ type: "stars", recipient: { username: "durov" }, quantity: 100 });
 * // → pay order.payment.amount to order.payment.pay_to_address with comment order.payment.memo
 * const finished = await client.waitForOrder(order.order_id);
 * ```
 */

export {
  MyStarsClient,
  PRODUCTION_BASE_URL,
  type MyStarsClientOptions,
  type RequestOptions,
  type CreateOrderOptions,
  type PricingParams,
  type CheckRecipientParams,
  type CreateOrderParams,
  type ListOrdersParams,
} from "./client.js";

export { OrdersPager, type FetchOrdersPage } from "./tracking/pager.js";
export { type WaitForOrderOptions } from "./tracking/waitForOrder.js";
export {
  reconcile,
  type ReconcileOptions,
  type ReconcileClient,
} from "./tracking/reconcile.js";

// Webhook verification + framework adapters
export { verifyWebhookSignature, constructEvent } from "./webhook/verify.js";
export {
  expressWebhook,
  fastifyWebhook,
  type WebhookMiddlewareOptions,
} from "./webhook/middleware.js";

// Retail-markup calculator
export {
  applyRetailMarkup,
  ceilUsdToCents,
  ceilTonTo4dp,
  type MarkupInput,
  type RetailMarkupConfig,
  type RetailQuote,
  type RetailLineItem,
} from "./pricing/markup.js";

// Non-custodial invoice builder
export {
  buildPaymentRequest,
  buildTonConnectMessages,
  buildTonDeeplink,
  toNano,
  toMicro,
  decimalToUnits,
  JETTON_TRANSFER_GAS_NANO,
  type PaymentRequest,
  type TonConnectMessage,
  type BuildInvoiceOptions,
} from "./payment/invoice.js";
export { buildCommentPayload } from "./payment/cell.js";
export {
  buildJettonTransferPayload,
  parseTonAddress,
  FORWARD_TON_AMOUNT_NANO,
  JETTON_TRANSFER_OP,
} from "./payment/jetton.js";

export {
  type Interceptors,
  type RequestLogInfo,
  type ResponseLogInfo,
  type RetryLogInfo,
} from "./http/transport.js";
export { type RetryPolicy, type RetryContext, defaultShouldRetry } from "./http/retry.js";

export {
  MyStarsValidationError,
  canonicalUsername,
  STARS_MIN_QUANTITY,
  STARS_MAX_QUANTITY,
  PREMIUM_MONTHS,
} from "./internal/validate.js";

export {
  MyStarsError,
  MyStarsApiError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  IdempotencyConflictError,
  OrderNotCancellableError,
  RecipientIneligibleError,
  RateLimitError,
  type RateLimitKind,
  ServiceUnavailableError,
  InternalServerError,
  NetworkError,
  TimeoutError,
  OrderWaitTimeoutError,
  WebhookSignatureError,
  errorFromResponse,
  parseRetryAfterMs,
} from "./errors.js";

export { CONTRACT_VERSION, SDK_VERSION } from "./version.js";

export {
  TERMINAL_STATUSES,
  WEBHOOK_TERMINAL,
  INITIAL_ORDER_STATUS,
  CANCELLABLE_STATUSES,
  isTerminal,
  type Currency,
  type OrderType,
  type Parameter,
  type OrderStatus,
  type TerminalStatus,
  type RecipientCheckReason,
  type FailureReason,
  type CurrencyInfo,
  type Product,
  type FeeBreakdown,
  type PricingQuote,
  type RecipientCheck,
  type PaymentInstruction,
  type Order,
  type CreateOrderResult,
  type OrdersPage,
  type WebhookStatus,
  type WebhookEvent,
} from "./types.js";
