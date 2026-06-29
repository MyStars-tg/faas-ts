/**
 * Lightweight client-side validation that mirrors the server's documented
 * constraints (and the `GET /v1/products` catalog), so common mistakes fail
 * fast without a round trip. These constants track the pinned CONTRACT_VERSION.
 */

import { MyStarsError } from "../errors.js";
import type { OrderType } from "../types.js";

/** Minimum Stars quantity a single order can buy (inclusive). */
export const STARS_MIN_QUANTITY = 50;
/** Maximum Stars quantity a single order can buy (inclusive). */
export const STARS_MAX_QUANTITY = 1_000_000;
/** The allowed Telegram Premium subscription lengths, in months. */
export const PREMIUM_MONTHS: readonly number[] = [3, 6, 12];
const USERNAME_RE = /^[a-z0-9_]{1,32}$/;

/** Thrown for invalid input caught before any HTTP request is made. */
export class MyStarsValidationError extends MyStarsError {}

/** Canonicalize a Telegram username the same way the server does: strip a leading `@`, lowercase. */
export function canonicalUsername(input: string): string {
  if (typeof input !== "string") {
    throw new MyStarsValidationError("recipient username must be a string");
  }
  const canon = input.trim().replace(/^@+/, "").toLowerCase();
  if (!USERNAME_RE.test(canon)) {
    throw new MyStarsValidationError(
      `invalid recipient username "${input}" — expected 1-32 chars of [a-z0-9_] (a leading @ is allowed)`,
    );
  }
  return canon;
}

/** Assert a Stars `quantity` is an integer within `[STARS_MIN_QUANTITY, STARS_MAX_QUANTITY]`. @throws {@link MyStarsValidationError} */
export function assertStarsQuantity(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity < STARS_MIN_QUANTITY || quantity > STARS_MAX_QUANTITY) {
    throw new MyStarsValidationError(
      `stars quantity must be an integer in [${STARS_MIN_QUANTITY}, ${STARS_MAX_QUANTITY}], got ${quantity}`,
    );
  }
}

/** Assert a Premium `months` value is one of {@link PREMIUM_MONTHS}. @throws {@link MyStarsValidationError} */
export function assertPremiumMonths(months: number): void {
  if (!PREMIUM_MONTHS.includes(months)) {
    throw new MyStarsValidationError(
      `premium months must be one of ${PREMIUM_MONTHS.join(", ")}, got ${months}`,
    );
  }
}

/** Assert `type` is a valid {@link OrderType} (`"stars"` or `"premium"`). @throws {@link MyStarsValidationError} */
export function assertOrderType(type: unknown): asserts type is OrderType {
  if (type !== "stars" && type !== "premium") {
    throw new MyStarsValidationError(`type must be "stars" or "premium", got ${String(type)}`);
  }
}
