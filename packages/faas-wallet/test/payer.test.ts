import { describe, it, expect } from "vitest";
import { Address, Cell } from "@ton/core";
import { MyStarsValidationError, type PaymentInstruction } from "@mystars-tg/faas-sdk";
import { OrderPayer, DEFAULT_USDT_MASTER } from "../src/payer.js";
import { TonWallet, WalletError, InsufficientBalanceError } from "../src/wallet.js";
import type { TonRpc } from "../src/rpc.js";

const PAY_TO = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
const JETTON_WALLET = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";
const MEMO = "3b488cdf-1f0a-4d3e-9a21-000000000000";

// Defaults fund the wallet generously so the pre-sign balance guard passes.
function rpc(over: Partial<TonRpc> = {}): TonRpc {
  return {
    getBalance: () => Promise.resolve(10_000_000_000n), // 10 TON
    getSeqno: () => Promise.resolve(0),
    resolveJettonWallet: () => Promise.resolve(JETTON_WALLET),
    getJettonBalance: () => Promise.resolve(1_000_000_000n), // 1000 USDT
    sendBoc: () => Promise.resolve(),
    ...over,
  };
}

function tonPayment(over: Partial<PaymentInstruction> = {}): PaymentInstruction {
  return { currency: "ton", chain: "ton", pay_to_address: PAY_TO, memo: MEMO, amount: "1.2345", amount_units: "ton", fee: null, ...over };
}

describe("OrderPayer.planMessages — TON", () => {
  it("plans an exact-amount transfer with the memo as an op-0 comment", async () => {
    const { wallet } = await TonWallet.generate();
    const [msg] = await new OrderPayer(wallet).planMessages(tonPayment(), { rpc: rpc() });
    expect(msg!.to).toBe(PAY_TO);
    expect(msg!.value).toBe(1234500000n);
    expect(msg!.bounce).toBe(false);
    const s = msg!.body.beginParse();
    expect(s.loadUint(32)).toBe(0);
    expect(s.loadStringTail()).toBe(MEMO);
  });

  it("throws when the memo is missing", async () => {
    const { wallet } = await TonWallet.generate();
    await expect(new OrderPayer(wallet).planMessages(tonPayment({ memo: null }), { rpc: rpc() })).rejects.toBeInstanceOf(WalletError);
  });

  it("rejects a zero amount before constructing any message", async () => {
    const { wallet } = await TonWallet.generate();
    await expect(new OrderPayer(wallet).planMessages(tonPayment({ amount: "0" }), { rpc: rpc() })).rejects.toBeInstanceOf(
      MyStarsValidationError,
    );
  });

  it("rejects a negative amount before constructing any message", async () => {
    const { wallet } = await TonWallet.generate();
    await expect(new OrderPayer(wallet).planMessages(tonPayment({ amount: "-1.0" }), { rpc: rpc() })).rejects.toBeInstanceOf(
      MyStarsValidationError,
    );
  });

  it("rejects a non-positive USDT amount before resolving the jetton wallet", async () => {
    const { wallet } = await TonWallet.generate();
    let resolved = false;
    const r = rpc({ resolveJettonWallet: () => { resolved = true; return Promise.resolve(JETTON_WALLET); } });
    const payment = tonPayment({ currency: "usdt_ton", amount_units: "usdt", amount: "0" });
    await expect(new OrderPayer(wallet).planMessages(payment, { rpc: r })).rejects.toBeInstanceOf(MyStarsValidationError);
    expect(resolved).toBe(false);
  });
});

describe("OrderPayer.planMessages — USDT", () => {
  it("resolves the payer's jetton wallet and builds a TEP-74 transfer to it", async () => {
    const { wallet } = await TonWallet.generate();
    let askedMaster = "";
    const r = rpc({
      resolveJettonWallet: (_owner, master) => {
        askedMaster = master;
        return Promise.resolve(JETTON_WALLET);
      },
    });
    const payment = tonPayment({ currency: "usdt_ton", amount_units: "usdt", amount: "4.99" });
    const [msg] = await new OrderPayer(wallet).planMessages(payment, { rpc: r });

    expect(askedMaster).toBe(DEFAULT_USDT_MASTER);
    expect(msg!.to).toBe(JETTON_WALLET); // sent to the PAYER's own jetton wallet
    expect(msg!.value).toBe(50000000n); // 0.05 TON gas (matches the core invoice builder)
    expect(msg!.bounce).toBe(true);

    const s = msg!.body.beginParse();
    expect(s.loadUint(32)).toBe(0xf8a7ea5);
    expect(s.loadUint(64)).toBe(0);
    expect(s.loadCoins()).toBe(4990000n);
    expect(s.loadAddress().equals(Address.parse(PAY_TO))).toBe(true); // destination = treasury owner
    expect(s.loadAddress().equals(Address.parse(wallet.address))).toBe(true); // response_destination = payer
    expect(s.loadBit()).toBe(false); // no custom_payload
    expect(s.loadCoins()).toBe(0n); // forward_ton_amount = 0
    const fwd = s.loadRef().beginParse();
    expect(fwd.loadUint(32)).toBe(0);
    expect(fwd.loadStringTail()).toBe(MEMO);
  });
});

describe("OrderPayer.payOrder", () => {
  it("signs once and broadcasts exactly one BoC (no funds move in tests)", async () => {
    const { wallet } = await TonWallet.generate();
    const sent: Uint8Array[] = [];
    const r = rpc({ getSeqno: () => Promise.resolve(0), sendBoc: (boc) => { sent.push(boc); return Promise.resolve(); } });
    const res = await new OrderPayer(wallet).payOrder({ payment: tonPayment(), order_id: "o1" }, { rpc: r, now: 1_000_000 });
    expect(sent).toHaveLength(1);
    expect(Cell.fromBoc(Buffer.from(sent[0]!)).length).toBe(1); // a valid serialized message
    expect(res.from).toBe(wallet.address);
    expect(res.to).toBe(PAY_TO);
    expect(res.amountSmallestUnit).toBe("1234500000");
    expect(res.orderId).toBe("o1");
  });

  it("uses the resolved jetton wallet as the recipient for a USDT order", async () => {
    const { wallet } = await TonWallet.generate();
    const sent: Uint8Array[] = [];
    const r = rpc({ sendBoc: (boc) => { sent.push(boc); return Promise.resolve(); } });
    const payment = tonPayment({ currency: "usdt_ton", amount_units: "usdt", amount: "4.99" });
    const res = await new OrderPayer(wallet).payOrder({ payment }, { rpc: r, now: 1_000_000 });
    expect(sent).toHaveLength(1);
    expect(res.to).toBe(JETTON_WALLET);
    expect(res.amountSmallestUnit).toBe("4990000");
  });

  it("throws InsufficientBalanceError (and broadcasts nothing) when underfunded", async () => {
    const { wallet } = await TonWallet.generate();
    const sent: Uint8Array[] = [];
    const r = rpc({ getBalance: () => Promise.resolve(0n), sendBoc: (boc) => { sent.push(boc); return Promise.resolve(); } });
    await expect(new OrderPayer(wallet).payOrder({ payment: tonPayment() }, { rpc: r })).rejects.toBeInstanceOf(InsufficientBalanceError);
    expect(sent).toHaveLength(0);
  });

  it("skipBalanceCheck bypasses the guard", async () => {
    const { wallet } = await TonWallet.generate();
    const r = rpc({ getBalance: () => Promise.resolve(0n) });
    await expect(new OrderPayer(wallet).payOrder({ payment: tonPayment() }, { rpc: r, skipBalanceCheck: true })).resolves.toMatchObject({ to: PAY_TO });
  });
});
