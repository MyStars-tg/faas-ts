/**
 * Non-custodial invoice builder.
 *
 * Turns an order's `payment` block into things you can pay with: smallest-unit
 * amounts, a `ton://transfer` deeplink, a Tonkeeper link, a QR payload, and TON
 * Connect message(s). This module holds NO keys and signs nothing — feed the
 * output to a wallet / TON Connect, or to `@mystars-tg/faas-wallet` to broadcast.
 */

import { MyStarsValidationError } from "../internal/validate.js";
import type { PaymentInstruction } from "../types.js";
import { buildCommentPayload } from "./cell.js";
import { buildJettonTransferPayload } from "./jetton.js";

/** Message value (nanoTON) attached to a USDT jetton transfer to cover its gas. */
export const JETTON_TRANSFER_GAS_NANO = "50000000"; // 0.05 TON

const DECIMAL_RE = /^\d+(\.\d+)?$/;

/**
 * Convert a non-negative decimal **string** to integer smallest units (half-up),
 * without IEEE-754 drift. Pass a string (e.g. `"8.1632"`), NOT a `number` — a JS
 * `number` is rejected because float literals (`8.1632`) can already carry binary
 * rounding error, which is exactly what this helper exists to avoid. A leading `-`
 * is rejected — a payment amount is never negative, and a signed value would build a
 * nonsensical (or zero) transfer.
 */
export function decimalToUnits(amount: string, decimals: number): bigint {
  // Guard against a non-string (e.g. a `number` reachable from plain JS): surface the
  // SDK's own validation error instead of a raw `TypeError` from a string method below.
  if (typeof amount !== "string") {
    throw new MyStarsValidationError(
      `amount must be a decimal string (e.g. "8.1632"), got ${typeof amount}`,
    );
  }
  // A clearer message for the common "negative amount" mistake (the regex below
  // also rejects a leading '-', but with a more generic message).
  if (amount.trimStart().startsWith("-")) {
    throw new MyStarsValidationError(`amount must not be negative, got "${amount}"`);
  }
  if (!DECIMAL_RE.test(amount)) throw new MyStarsValidationError(`invalid decimal amount "${amount}"`);
  const [intPart, fracPart = ""] = amount.split(".");
  const scaledFrac = fracPart.padEnd(decimals + 1, "0");
  const keep = scaledFrac.slice(0, decimals);
  const roundDigit = scaledFrac[decimals];
  let units = BigInt((intPart || "0") + keep);
  if (roundDigit !== undefined && Number(roundDigit) >= 5) units += 1n;
  return units;
}

/** Decimal TON **string** (e.g. `"8.1632"`, not a `number`) → nanoTON. */
export function toNano(amount: string): bigint {
  return decimalToUnits(amount, 9);
}

/** Decimal USDT **string** (e.g. `"14.13"`, not a `number`) → micro-USDT. */
export function toMicro(amount: string): bigint {
  return decimalToUnits(amount, 6);
}

/** One TON Connect `messages[]` entry — feed to `tonConnectUI.sendTransaction({ messages })`. */
export interface TonConnectMessage {
  address: string;
  /** nanoTON, as a string (TON Connect's expected form). */
  amount: string;
  /** base64 BoC payload. */
  payload?: string;
}

/** Options for the invoice builders — only needed to produce a signable USDT (jetton) message. */
export interface BuildInvoiceOptions {
  /** The payer's wallet address (raw or friendly) — required to build a USDT jetton message. */
  senderAddress?: string;
  /** The payer's OWN USDT jetton wallet address — required to build a USDT TON Connect message. */
  jettonWalletAddress?: string;
  /** Validity window for the TON Connect transaction, in seconds. Default 600. */
  validForSeconds?: number;
  /** Stamp for `valid_until` (epoch ms). Pass `Date.now()` — kept injectable for determinism. */
  now?: number;
}

/** The aggregated payable artifacts for an order, returned by {@link buildPaymentRequest}. */
export interface PaymentRequest {
  currency: PaymentInstruction["currency"];
  payToAddress: string;
  memo: string;
  amountUnits: "ton" | "usdt";
  /** nanoTON (ton) or micro-USDT (usdt_ton), as a string. */
  amountSmallestUnit: string;
  /** `ton://transfer/...` — TON only (a USDT jetton transfer has no plain deeplink). */
  tonDeeplink?: string;
  /** `https://app.tonkeeper.com/transfer/...` — TON only. */
  tonkeeperLink?: string;
  /** A URI to render as a QR code — TON only. */
  qrPayload?: string;
  /** TON Connect `messages` array (USDT requires `senderAddress` + `jettonWalletAddress`). */
  tonConnect: TonConnectMessage[];
  /** Set when a field couldn't be produced (e.g. USDT without a resolved jetton wallet). */
  note?: string;
}

function requireAddress(p: PaymentInstruction): string {
  if (!p.pay_to_address) throw new MyStarsValidationError("payment.pay_to_address is missing");
  return p.pay_to_address;
}

function requireMemo(p: PaymentInstruction): string {
  if (!p.memo) throw new MyStarsValidationError("payment.memo is missing");
  return p.memo;
}

/** Resolve the smallest-unit amount and reject a non-positive (zero/negative) value before building anything. */
function requirePositiveUnits(p: PaymentInstruction): bigint {
  const units = p.currency === "ton" ? toNano(p.amount) : toMicro(p.amount);
  if (units <= 0n) {
    throw new MyStarsValidationError(`payment amount must be positive, got "${p.amount}"`);
  }
  return units;
}

/**
 * Build TON Connect message(s) for the payment. Throws for a USDT payment unless
 * `senderAddress` + `jettonWalletAddress` are supplied (a jetton message must be
 * sent to the payer's own jetton wallet).
 */
export function buildTonConnectMessages(
  payment: PaymentInstruction,
  opts: BuildInvoiceOptions = {},
): TonConnectMessage[] {
  const payTo = requireAddress(payment);
  const memo = requireMemo(payment);
  requirePositiveUnits(payment);
  if (payment.currency === "ton") {
    return [{ address: payTo, amount: toNano(payment.amount).toString(), payload: buildCommentPayload(memo) }];
  }
  // usdt_ton
  if (!opts.senderAddress || !opts.jettonWalletAddress) {
    throw new MyStarsValidationError(
      "a USDT TON Connect message needs senderAddress + jettonWalletAddress (the payer's own USDT jetton wallet)",
    );
  }
  const payload = buildJettonTransferPayload(toMicro(payment.amount), payTo, opts.senderAddress, memo);
  return [{ address: opts.jettonWalletAddress, amount: JETTON_TRANSFER_GAS_NANO, payload }];
}

/** Build a `ton://transfer` deeplink. TON only — throws for USDT. */
export function buildTonDeeplink(payment: PaymentInstruction): string {
  if (payment.currency !== "ton") {
    throw new MyStarsValidationError("a ton:// deeplink is only valid for `ton` payments (USDT needs a jetton transfer)");
  }
  const payTo = requireAddress(payment);
  const memo = requireMemo(payment);
  requirePositiveUnits(payment);
  const nano = toNano(payment.amount).toString();
  return `ton://transfer/${payTo}?amount=${nano}&text=${encodeURIComponent(memo)}`;
}

/**
 * Aggregate everything you can pay the order with. Best-effort: TON yields the
 * full set; USDT yields the smallest-unit amount + TON Connect message only when
 * `senderAddress` + `jettonWalletAddress` are supplied (otherwise `note` explains).
 */
export function buildPaymentRequest(payment: PaymentInstruction, opts: BuildInvoiceOptions = {}): PaymentRequest {
  const payTo = requireAddress(payment);
  const memo = requireMemo(payment);
  requirePositiveUnits(payment);

  if (payment.currency === "ton") {
    const nano = toNano(payment.amount).toString();
    const deeplink = `ton://transfer/${payTo}?amount=${nano}&text=${encodeURIComponent(memo)}`;
    return {
      currency: "ton",
      payToAddress: payTo,
      memo,
      amountUnits: "ton",
      amountSmallestUnit: nano,
      tonDeeplink: deeplink,
      tonkeeperLink: `https://app.tonkeeper.com/transfer/${payTo}?amount=${nano}&text=${encodeURIComponent(memo)}`,
      qrPayload: deeplink,
      tonConnect: [{ address: payTo, amount: nano, payload: buildCommentPayload(memo) }],
    };
  }

  // usdt_ton
  const micro = toMicro(payment.amount).toString();
  const base: PaymentRequest = {
    currency: "usdt_ton",
    payToAddress: payTo,
    memo,
    amountUnits: "usdt",
    amountSmallestUnit: micro,
    tonConnect: [],
  };
  if (opts.senderAddress && opts.jettonWalletAddress) {
    base.tonConnect = buildTonConnectMessages(payment, opts);
  } else {
    base.note =
      "USDT: pass senderAddress + jettonWalletAddress (the payer's own USDT jetton wallet) to build a signable TON Connect message.";
  }
  return base;
}
