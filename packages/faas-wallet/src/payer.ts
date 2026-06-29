/**
 * `OrderPayer` — pay a FaaS order invoice from your own `TonWallet`.
 *
 * Signs ONCE and broadcasts. For `ton` it sends an exact-amount transfer with the
 * order memo as an op-0 comment; for `usdt_ton` it resolves the payer's own USDT
 * jetton wallet and sends a TEP-74 transfer whose `destination` is the FaaS
 * `pay_to_address` and whose forward payload carries the memo.
 *
 * NOTE: this moves the PARTNER's own funds from the partner's own wallet — never
 * the MyStars treasury. Tests use a mock `TonRpc` so nothing broadcasts.
 */

import { Address, SendMode, beginCell, external, internal, storeMessage, toNano, type Cell, type MessageRelaxed } from "@ton/core";
import { JETTON_TRANSFER_OP, MyStarsValidationError, toMicro } from "@mystars-tg/faas-sdk";
import type { CreateOrderResult, PaymentInstruction } from "@mystars-tg/faas-sdk";
import type { TonRpc } from "./rpc.js";
import { InsufficientBalanceError, TonWallet, WalletError } from "./wallet.js";

/** Mainnet Tether USDT jetton master on TON. Override via `PayOrderOptions.jettonMaster` for testnet. */
export const DEFAULT_USDT_MASTER = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
/** TON attached to a USDT jetton transfer to cover its gas (excess refunds to the sender). Matches the core invoice builder. */
export const DEFAULT_JETTON_GAS_TON = "0.05";
/** Extra TON kept aside for the external-message processing fee on top of the payment. */
const NETWORK_FEE_RESERVE = toNano("0.02");

/** Options for {@link OrderPayer.payOrder} / {@link OrderPayer.planMessages}. */
export interface PayOrderOptions {
  /** The RPC used to resolve the jetton wallet, read balances, and broadcast. */
  rpc: TonRpc;
  /** USDT jetton master (defaults to mainnet Tether). */
  jettonMaster?: string;
  /** TON gas attached to a USDT transfer (default 0.05). */
  jettonGasTon?: string;
  /** Transfer validity window in seconds (default 120 — a non-landed send dies fast, safe to retry). */
  validForSeconds?: number;
  /** Skip the pre-sign balance check (saves 1-2 RPC calls; default false). */
  skipBalanceCheck?: boolean;
  /** Injectable clock (epoch ms) for deterministic tests. */
  now?: number;
}

/** The outcome of a broadcast payment from {@link OrderPayer.payOrder}. */
export interface PayOrderResult {
  /** The order id paid. */
  orderId?: string;
  /** The paying wallet address. */
  from: string;
  /** The recipient (FaaS treasury owner) address. */
  to: string;
  /** The smallest-unit amount sent (nanoTON for ton, micro-USDT for usdt_ton). */
  amountSmallestUnit: string;
}

/** An internal message the payer will sign into a transfer. Exposed for testing. */
export interface PlannedMessage {
  to: string;
  value: bigint;
  body: Cell;
  bounce: boolean;
}

function commentCell(memo: string): Cell {
  return beginCell().storeUint(0, 32).storeStringTail(memo).endCell();
}

/**
 * Pays a FaaS order invoice from a single {@link TonWallet}.
 *
 * @example
 * ```ts
 * const order = await client.createOrder(
 *   { type: "stars", recipient: { username: "durov" }, quantity: 100 },
 *   { idempotencyKey: `order-${myId}` },
 * );
 * const rpc = new ToncenterRpc({ endpoint: "https://toncenter.com/api/v2/jsonRPC" });
 * const { from, to, amountSmallestUnit } = await new OrderPayer(wallet).payOrder(order, { rpc });
 * const finished = await client.waitForOrder(order.order_id);
 * ```
 */
export class OrderPayer {
  private readonly wallet: TonWallet;

  /** @param wallet - the funded {@link TonWallet} whose own funds will pay invoices */
  constructor(wallet: TonWallet) {
    this.wallet = wallet;
  }

  /**
   * Plan the internal message(s) for an order WITHOUT signing or broadcasting.
   * `ton` is pure; `usdt_ton` resolves the payer's jetton wallet via `rpc`.
   */
  async planMessages(payment: PaymentInstruction, opts: PayOrderOptions): Promise<PlannedMessage[]> {
    if (!payment.pay_to_address) throw new WalletError("payment.pay_to_address is missing");
    if (!payment.memo) throw new WalletError("payment.memo is missing");

    if (payment.currency === "ton") {
      const value = toNano(payment.amount);
      if (value <= 0n) {
        throw new MyStarsValidationError(`payment amount must be positive, got "${payment.amount}"`);
      }
      return [{ to: payment.pay_to_address, value, body: commentCell(payment.memo), bounce: false }];
    }

    // usdt_ton — TEP-74 transfer to the payer's OWN jetton wallet.
    const microAmount = toMicro(payment.amount);
    if (microAmount <= 0n) {
      throw new MyStarsValidationError(`payment amount must be positive, got "${payment.amount}"`);
    }
    const jettonMaster = opts.jettonMaster ?? DEFAULT_USDT_MASTER;
    const jettonWallet = await opts.rpc.resolveJettonWallet(this.wallet.address, jettonMaster);
    const body = beginCell()
      .storeUint(JETTON_TRANSFER_OP, 32)
      .storeUint(0n, 64) // query_id
      .storeCoins(microAmount)
      .storeAddress(Address.parse(payment.pay_to_address)) // destination = FaaS treasury owner
      .storeAddress(this.wallet.tonAddress) // response_destination = payer
      .storeBit(false) // no custom_payload
      .storeCoins(0n) // forward_ton_amount = 0
      .storeBit(true)
      .storeRef(commentCell(payment.memo)) // forward_payload (memo)
      .endCell();
    return [
      { to: jettonWallet, value: toNano(opts.jettonGasTon ?? DEFAULT_JETTON_GAS_TON), body, bounce: true },
    ];
  }

  /** Throw `InsufficientBalanceError` if the wallet can't cover the planned payment + gas. */
  private async assertFunded(payment: PaymentInstruction, planned: PlannedMessage[], rpc: TonRpc): Promise<void> {
    const tonBalance = await rpc.getBalance(this.wallet.address);
    const first = planned[0]!;
    if (payment.currency === "ton") {
      const need = first.value + NETWORK_FEE_RESERVE;
      if (tonBalance < need) {
        throw new InsufficientBalanceError(`insufficient TON: balance ${tonBalance} < required ~${need} (nanoTON)`);
      }
      return;
    }
    // usdt_ton: need TON for the jetton gas + processing fee, AND enough USDT.
    const gasNeed = first.value + NETWORK_FEE_RESERVE;
    if (tonBalance < gasNeed) {
      throw new InsufficientBalanceError(`insufficient TON for jetton gas: balance ${tonBalance} < required ~${gasNeed} (nanoTON)`);
    }
    const jettonBalance = await rpc.getJettonBalance(first.to);
    const micro = toMicro(payment.amount);
    if (jettonBalance < micro) {
      throw new InsufficientBalanceError(`insufficient USDT: balance ${jettonBalance} < required ${micro} (micro-USDT)`);
    }
  }

  /**
   * Build, sign, and broadcast the payment for an order. Signs exactly ONCE.
   *
   * MONEY: this broadcasts a real on-chain transfer of the wallet's OWN funds.
   * It is not idempotent — calling it twice for the same order pays twice. Guard
   * retries at the order layer (a stable `Idempotency-Key` on `createOrder`, or
   * use `fulfill` which only pays an order still `awaiting_payment`).
   *
   * @param order - a `CreateOrderResult`, or any object carrying a `payment` block (and optional `order_id`)
   * @param opts - the {@link PayOrderOptions} (at minimum `rpc`)
   * @returns the {@link PayOrderResult} — `from`/`to` addresses and the smallest-unit amount sent
   * @throws `WalletError` if the order's `payment` block is missing `pay_to_address`/`memo`
   * @throws `MyStarsValidationError` if the amount is non-positive
   * @throws {@link InsufficientBalanceError} if the wallet can't cover the payment + gas (unless `skipBalanceCheck`)
   */
  async payOrder(order: CreateOrderResult | { payment: PaymentInstruction; order_id?: string }, opts: PayOrderOptions): Promise<PayOrderResult> {
    const payment = order.payment;
    const planned = await this.planMessages(payment, opts);
    if (!opts.skipBalanceCheck) await this.assertFunded(payment, planned, opts.rpc);
    const seqno = await opts.rpc.getSeqno(this.wallet.address);
    const messages: MessageRelaxed[] = planned.map((m) =>
      internal({ to: Address.parse(m.to), value: m.value, body: m.body, bounce: m.bounce }),
    );
    const timeout = Math.floor((opts.now ?? Date.now()) / 1000) + (opts.validForSeconds ?? 120);
    const transfer = this.wallet.createTransfer({ seqno, messages, sendMode: SendMode.PAY_GAS_SEPARATELY, timeout });
    const ext = external({
      to: this.wallet.tonAddress,
      init: seqno === 0 ? this.wallet.init : undefined,
      body: transfer,
    });
    const boc = beginCell().store(storeMessage(ext)).endCell().toBoc();
    await opts.rpc.sendBoc(boc);

    const first = planned[0]!;
    return {
      orderId: order.order_id,
      from: this.wallet.address,
      to: first.to,
      amountSmallestUnit: (payment.currency === "ton" ? toNano(payment.amount) : toMicro(payment.amount)).toString(),
    };
  }
}
