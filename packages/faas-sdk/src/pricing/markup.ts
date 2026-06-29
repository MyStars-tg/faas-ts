/**
 * Retail-markup calculator.
 *
 * Takes our WHOLESALE quote (what you pay us) and computes the price to charge
 * your end-customer after adding your OWN retail margin — and, optionally,
 * passing our processing fee straight through to the customer.
 *
 * Money is handled to the same grid the server uses: USDT to whole cents via the
 * exact two-stage cent-ceil (`ceilUsdToCents`), and TON to the 0.0001-GRAM grid.
 * The cross-language `markup-vectors.json` fixture pins this so the TS and Python
 * SDKs produce identical retail prices.
 *
 * NOTE: our wholesale markup is set server-side and is redacted — this module
 * never sees it. The margin here is purely YOUR retail margin on top of the
 * quoted wholesale amount.
 */

import { MyStarsValidationError } from "../internal/validate.js";
import type { Currency, FeeBreakdown } from "../types.js";

/**
 * Ceil a USD(T) amount to whole cents WITHOUT IEEE-754 drift — snap to integer
 * micro-USDT first, then ceil to the cent grid. Byte-identical to the server's
 * `ceilUsdToCents` (web checkout + FaaS `/v1/pricing` land on the same cent).
 *
 * @example ceilUsdToCents(0.06)   // 0.06  (naive Math.ceil(x*100)/100 returns 0.07)
 * @example ceilUsdToCents(3.3461) // 3.35
 */
export function ceilUsdToCents(usd: number): number {
  const micro = Math.round(usd * 1e6);
  return Math.ceil(micro / 1e4) / 100;
}

/** Ceil a TON amount to the 0.0001-GRAM grid (snap to integer nanoTON first). */
export function ceilTonTo4dp(ton: number): number {
  const nano = Math.round(ton * 1e9);
  return Math.ceil(nano / 1e5) / 1e4;
}

/** The wholesale quote a retail markup is applied to (a `PricingQuote` or a `PaymentInstruction` both fit). */
export interface MarkupInput {
  amount: string;
  currency: Currency;
  fee: FeeBreakdown | null;
}

/** Your retail-margin configuration for {@link applyRetailMarkup}. */
export interface RetailMarkupConfig {
  /** Your retail margin, in percent, applied to the goods value (e.g. 12.5 for +12.5%). */
  marginPct: number;
  /**
   * When true (default), our processing fee (`usdt_ton` only) is added to the
   * customer total as a separate line — the customer pays it, you remit it to us,
   * and it doesn't eat your margin. When false, you absorb the fee out of your margin.
   */
  passThroughProcessingFee?: boolean;
}

/** One labelled line of a {@link RetailQuote} breakdown (label + decimal-string amount). */
export interface RetailLineItem {
  label: string;
  amount: string;
}

/** The customer-facing breakdown returned by {@link applyRetailMarkup}. All amounts are decimal strings. */
export interface RetailQuote {
  currency: Currency;
  /** What you pay us (the wholesale quote amount). */
  wholesaleAmount: string;
  marginPct: number;
  /** The base goods value before your margin (the fee's `subtotal` for usdt_ton, else `amount`). */
  goods: string;
  /** Your added margin (subtotal − goods). */
  markup: string;
  /** Marked-up goods (goods + markup). */
  subtotal: string;
  /** Passed-through processing fee (usdt_ton + passThrough), else "0". */
  processingFee: string;
  /** What to charge your customer (subtotal + processingFee). */
  total: string;
  /** Your gross margin on the sale (total − wholesaleAmount). */
  profit: string;
  lineItems: RetailLineItem[];
}

/** Parse a decimal amount string, rejecting NaN/Infinity so we never emit "NaN" line items. */
function num(value: string, label: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new MyStarsValidationError(`${label} must be a finite decimal, got "${value}"`);
  return n;
}

function fmtUsd(n: number): string {
  return n.toFixed(2);
}

function fmtTon(n: number): string {
  // n is on the 0.0001 grid; render up to 4dp, trimming trailing zeros.
  let s = n.toFixed(4);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

/**
 * Apply your retail margin to a wholesale quote and return an itemized
 * customer-facing breakdown.
 */
export function applyRetailMarkup(input: MarkupInput, config: RetailMarkupConfig): RetailQuote {
  const marginPct = config.marginPct;
  if (!Number.isFinite(marginPct) || marginPct < 0) {
    throw new MyStarsValidationError(`marginPct must be a non-negative number, got ${marginPct}`);
  }
  const passThrough = config.passThroughProcessingFee ?? true;
  const amount = num(input.amount, "amount");
  const factor = 1 + marginPct / 100;

  if (input.currency === "usdt_ton") {
    // `amount` for usdt_ton is fee-INCLUSIVE. Without the fee breakdown we cannot
    // separate goods from the processing fee, so applying the margin to `amount`
    // would mark up the fee too AND mislabel the "Goods" line. Refuse — the caller
    // must re-quote to get the `fee` block.
    if (!input.fee) {
      throw new MyStarsValidationError(
        "usdt_ton amount has no fee breakdown; re-quote via GET /v1/pricing before applying markup",
      );
    }
    const goods = num(input.fee.subtotal, "fee.subtotal");
    const ourFee = num(input.fee.processing_fee, "fee.processing_fee");
    const retailGoods = ceilUsdToCents(goods * factor);
    const customerFee = passThrough ? ceilUsdToCents(ourFee) : 0;
    const markup = retailGoods - goods;
    const total = retailGoods + customerFee;
    const profit = total - amount;
    return {
      currency: "usdt_ton",
      wholesaleAmount: input.amount,
      marginPct,
      goods: fmtUsd(goods),
      markup: fmtUsd(markup),
      subtotal: fmtUsd(retailGoods),
      processingFee: fmtUsd(customerFee),
      total: fmtUsd(total),
      profit: fmtUsd(profit),
      lineItems: [
        { label: "Goods", amount: fmtUsd(goods) },
        { label: `Retail margin (${marginPct}%)`, amount: fmtUsd(markup) },
        { label: "Processing fee", amount: fmtUsd(customerFee) },
      ],
    };
  }

  // ton — no processing fee.
  const retailGoods = ceilTonTo4dp(amount * factor);
  const markup = retailGoods - amount;
  return {
    currency: "ton",
    wholesaleAmount: input.amount,
    marginPct,
    goods: fmtTon(amount),
    markup: fmtTon(markup),
    subtotal: fmtTon(retailGoods),
    processingFee: "0",
    total: fmtTon(retailGoods),
    profit: fmtTon(markup),
    lineItems: [
      { label: "Goods", amount: fmtTon(amount) },
      { label: `Retail margin (${marginPct}%)`, amount: fmtTon(markup) },
    ],
  };
}
