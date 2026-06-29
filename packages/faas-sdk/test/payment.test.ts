import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Address, Cell } from "@ton/core";
import {
  toNano,
  toMicro,
  decimalToUnits,
  buildTonDeeplink,
  buildPaymentRequest,
  buildTonConnectMessages,
} from "../src/payment/invoice.js";
import { buildCommentPayload } from "../src/payment/cell.js";
import { buildJettonTransferPayload, parseTonAddress } from "../src/payment/jetton.js";
import { MyStarsValidationError } from "../src/internal/validate.js";
import type { PaymentInstruction } from "../src/types.js";

interface DeeplinkVectors {
  conversions: { amount: string; currency: "ton" | "usdt_ton"; smallest: string }[];
  ton_deeplink: { pay_to_address: string; amount: string; memo: string; deeplink: string }[];
  comment_payload: { comment: string; boc_base64: string }[];
  jetton_payload: { amount_micro: string; destination: string; sender: string; memo: string; boc_base64: string }[];
}
const vectors: DeeplinkVectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../contract/deeplink-vectors.json", import.meta.url)), "utf8"),
);

function tonPayment(over: Partial<PaymentInstruction>): PaymentInstruction {
  return { currency: "ton", chain: "ton", pay_to_address: "EQx", memo: "m", amount: "1.0", amount_units: "ton", fee: null, ...over };
}

describe("decimal → smallest-unit conversions (contract vectors)", () => {
  for (const c of vectors.conversions) {
    it(`${c.amount} ${c.currency} → ${c.smallest}`, () => {
      const got = c.currency === "ton" ? toNano(c.amount) : toMicro(c.amount);
      expect(got.toString()).toBe(c.smallest);
    });
  }
  it("rejects a malformed amount", () => {
    expect(() => toNano("1.2.3")).toThrow(MyStarsValidationError);
  });
  it("rejects a leading-minus (negative) amount", () => {
    expect(() => toNano("-1.0")).toThrow(MyStarsValidationError);
    expect(() => toMicro("-0.5")).toThrow(MyStarsValidationError);
  });
  it("rejects a non-string amount with a domain error (not a raw TypeError)", () => {
    // Reachable from plain JS (no compile-time check). Must surface MyStarsValidationError,
    // not "TypeError: amount.trimStart is not a function".
    expect(() => toNano(1.5 as unknown as string)).toThrow(MyStarsValidationError);
    expect(() => toMicro(8 as unknown as string)).toThrow(MyStarsValidationError);
    expect(() => toNano(1.5 as unknown as string)).toThrow(/decimal string/);
    expect(() => decimalToUnits(123 as unknown as string, 9)).toThrow(MyStarsValidationError);
  });
});

describe("positive-amount guard", () => {
  it("buildPaymentRequest rejects a zero amount", () => {
    expect(() => buildPaymentRequest(tonPayment({ amount: "0" }))).toThrow(MyStarsValidationError);
  });
  it("buildPaymentRequest rejects a negative amount", () => {
    expect(() => buildPaymentRequest(tonPayment({ amount: "-1.0" }))).toThrow(MyStarsValidationError);
  });
  it("buildTonDeeplink rejects a zero amount", () => {
    expect(() => buildTonDeeplink(tonPayment({ amount: "0" }))).toThrow(MyStarsValidationError);
  });
  it("buildTonConnectMessages rejects a zero USDT amount", () => {
    const p = tonPayment({ currency: "usdt_ton", amount_units: "usdt", amount: "0", pay_to_address: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs" });
    expect(() => buildTonConnectMessages(p, { senderAddress: "EQx", jettonWalletAddress: "EQy" })).toThrow(
      MyStarsValidationError,
    );
  });
});

describe("buildCommentPayload", () => {
  it("matches the frozen BoC and decodes correctly via @ton/core", () => {
    const v = vectors.comment_payload[0]!;
    const boc = buildCommentPayload(v.comment);
    expect(boc).toBe(v.boc_base64);
    const s = Cell.fromBase64(boc).beginParse();
    expect(s.loadUint(32)).toBe(0); // op-0 comment
    expect(s.loadStringTail()).toBe(v.comment);
  });

  it("accepts a 123-byte comment and decodes it exactly (single-cell max)", () => {
    const comment = "a".repeat(123);
    const boc = buildCommentPayload(comment);
    const s = Cell.fromBase64(boc).beginParse();
    expect(s.loadUint(32)).toBe(0);
    expect(s.loadStringTail()).toBe(comment);
  });

  it("throws on a 124-byte comment instead of emitting a corrupt single-cell BoC", () => {
    expect(() => buildCommentPayload("a".repeat(124))).toThrow(MyStarsValidationError);
  });
});

describe("buildJettonTransferPayload memo guard", () => {
  it("throws on a >123-byte memo instead of overflowing the forward-payload ref cell", () => {
    const v = vectors.jetton_payload[0]!;
    expect(() => buildJettonTransferPayload(v.amount_micro, v.destination, v.sender, "m".repeat(124))).toThrow(
      MyStarsValidationError,
    );
  });
});

describe("buildJettonTransferPayload", () => {
  it("matches the frozen BoC and decodes to a correct TEP-74 transfer via @ton/core", () => {
    const v = vectors.jetton_payload[0]!;
    const boc = buildJettonTransferPayload(v.amount_micro, v.destination, v.sender, v.memo);
    expect(boc).toBe(v.boc_base64);
    const s = Cell.fromBase64(boc).beginParse();
    expect(s.loadUint(32)).toBe(0xf8a7ea5); // jetton transfer opcode
    expect(s.loadUint(64)).toBe(0); // query_id
    expect(s.loadCoins()).toBe(BigInt(v.amount_micro));
    expect(s.loadAddress().equals(Address.parse(v.destination))).toBe(true);
    expect(s.loadAddress().equals(Address.parse(v.sender))).toBe(true);
    s.loadBit(); // custom_payload (none)
    s.loadCoins(); // forward_ton_amount
    const fwd = s.loadRef().beginParse();
    expect(fwd.loadUint(32)).toBe(0);
    expect(fwd.loadStringTail()).toBe(v.memo);
  });

  it("accepts a bigint amount", () => {
    const v = vectors.jetton_payload[0]!;
    expect(buildJettonTransferPayload(BigInt(v.amount_micro), v.destination, v.sender, v.memo)).toBe(v.boc_base64);
  });
});

describe("parseTonAddress", () => {
  it("parses a friendly address to workchain 0 + 32-byte hash", () => {
    const p = parseTonAddress("EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs");
    expect(p.workchain).toBe(0);
    expect(p.hash.length).toBe(32);
  });
  it("throws on a checksum-broken friendly address", () => {
    expect(() => parseTonAddress("EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDX")).toThrow();
  });
  it("throws on a bad raw workchain", () => {
    expect(() => parseTonAddress("5:" + "0".repeat(64))).toThrow();
  });
});

describe("buildTonDeeplink + buildPaymentRequest", () => {
  it("TON deeplink matches the contract vector", () => {
    const v = vectors.ton_deeplink[0]!;
    const p = tonPayment({ pay_to_address: v.pay_to_address, memo: v.memo, amount: v.amount });
    expect(buildTonDeeplink(p)).toBe(v.deeplink);
    const req = buildPaymentRequest(p);
    expect(req.tonDeeplink).toBe(v.deeplink);
    expect(req.amountSmallestUnit).toBe("1500000000");
    expect(req.tonConnect[0]!.address).toBe(v.pay_to_address);
    expect(req.tonConnect[0]!.payload).toBe(buildCommentPayload(v.memo));
  });

  it("buildTonDeeplink throws for a USDT payment", () => {
    const p = tonPayment({ currency: "usdt_ton", amount_units: "usdt" });
    expect(() => buildTonDeeplink(p)).toThrow(MyStarsValidationError);
  });

  it("USDT buildPaymentRequest without a jetton wallet returns the micro amount + a note, no tonConnect", () => {
    const p = tonPayment({ currency: "usdt_ton", amount_units: "usdt", amount: "4.99" });
    const req = buildPaymentRequest(p);
    expect(req.amountSmallestUnit).toBe("4990000");
    expect(req.tonConnect).toEqual([]);
    expect(req.note).toBeTruthy();
  });

  it("USDT buildTonConnectMessages throws without a resolved jetton wallet", () => {
    const p = tonPayment({ currency: "usdt_ton", amount_units: "usdt", amount: "4.99", pay_to_address: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs" });
    expect(() => buildTonConnectMessages(p)).toThrow(MyStarsValidationError);
  });

  it("USDT buildTonConnectMessages builds a jetton message when the wallet is supplied", () => {
    const v = vectors.jetton_payload[0]!;
    const p = tonPayment({ currency: "usdt_ton", amount_units: "usdt", amount: "4.99", pay_to_address: v.destination, memo: v.memo });
    const msgs = buildTonConnectMessages(p, { senderAddress: v.sender, jettonWalletAddress: v.destination });
    expect(msgs[0]!.address).toBe(v.destination);
    expect(msgs[0]!.payload).toBe(v.boc_base64);
  });
});
