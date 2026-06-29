import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyRetailMarkup, ceilUsdToCents, ceilTonTo4dp, type MarkupInput, type RetailMarkupConfig } from "../src/pricing/markup.js";
import { MyStarsValidationError } from "../src/internal/validate.js";

interface MarkupVectors {
  ceil_usd_to_cents: { usd: number; cents: number }[];
  retail_markup: {
    name: string;
    input: MarkupInput;
    config: RetailMarkupConfig;
    expected: { goods: string; markup: string; subtotal: string; processingFee: string; total: string; profit: string };
  }[];
}
const vectors: MarkupVectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../contract/markup-vectors.json", import.meta.url)), "utf8"),
);

describe("ceilUsdToCents (contract vectors)", () => {
  for (const { usd, cents } of vectors.ceil_usd_to_cents) {
    it(`${usd} → ${cents}`, () => {
      expect(ceilUsdToCents(usd)).toBe(cents);
    });
  }
  it("avoids the naive Math.ceil(x*100)/100 over-charge", () => {
    expect(ceilUsdToCents(0.01 + 0.05)).toBe(0.06);
  });
});

describe("ceilTonTo4dp", () => {
  it("ceils to the 0.0001 grid", () => {
    expect(ceilTonTo4dp(1.35795)).toBe(1.358);
    expect(ceilTonTo4dp(2.5)).toBe(2.5);
  });
});

describe("applyRetailMarkup (contract vectors)", () => {
  for (const v of vectors.retail_markup) {
    it(v.name, () => {
      const q = applyRetailMarkup(v.input, v.config);
      expect({
        goods: q.goods,
        markup: q.markup,
        subtotal: q.subtotal,
        processingFee: q.processingFee,
        total: q.total,
        profit: q.profit,
      }).toEqual(v.expected);
    });
  }

  it("invariant: subtotal + processingFee == total for every usdt vector", () => {
    for (const v of vectors.retail_markup) {
      if (v.input.currency !== "usdt_ton") continue;
      const q = applyRetailMarkup(v.input, v.config);
      expect((Number(q.subtotal) + Number(q.processingFee)).toFixed(2)).toBe(Number(q.total).toFixed(2));
    }
  });

  it("emits itemized line items", () => {
    const q = applyRetailMarkup(vectors.retail_markup[0]!.input, vectors.retail_markup[0]!.config);
    expect(q.lineItems.map((l) => l.label)).toEqual(["Goods", "Retail margin (20%)", "Processing fee"]);
  });

  it("rejects a usdt_ton input with no fee breakdown (would mark up the fee + mislabel goods)", () => {
    expect(() =>
      applyRetailMarkup({ amount: "5.56", currency: "usdt_ton", fee: null }, { marginPct: 20 }),
    ).toThrow(MyStarsValidationError);
  });

  it("still computes a usdt_ton breakdown when the fee is present", () => {
    const q = applyRetailMarkup(
      {
        amount: "5.56",
        currency: "usdt_ton",
        fee: { subtotal: "5.00", processing_fee: "0.56", total: "5.56", description: "1% swap + 0.5 GRAM gas", currency: "usdt" },
      },
      { marginPct: 20 },
    );
    expect(q.total).toBe("6.56");
    expect(q.goods).toBe("5.00");
  });

  it("rejects a negative margin", () => {
    expect(() => applyRetailMarkup({ amount: "1", currency: "ton", fee: null }, { marginPct: -5 })).toThrow(MyStarsValidationError);
  });

  it("rejects a non-numeric amount instead of emitting NaN", () => {
    expect(() => applyRetailMarkup({ amount: "abc", currency: "ton", fee: null }, { marginPct: 10 })).toThrow(MyStarsValidationError);
  });
});
