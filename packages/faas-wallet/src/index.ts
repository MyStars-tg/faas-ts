/**
 * @mystars-tg/faas-wallet — opt-in TON wallet + payer for the MyStars FaaS SDK.
 *
 * Node-only. Generate or import a TON wallet, read balances, and pay a FaaS order
 * invoice (TON or USDT) from YOUR OWN wallet. Keys live only in memory and are
 * never persisted, logged, or transmitted.
 *
 * @example
 * ```ts
 * import { MyStarsClient } from "@mystars-tg/faas-sdk";
 * import { TonWallet, ToncenterRpc, fulfill } from "@mystars-tg/faas-wallet";
 *
 * const { wallet, mnemonic } = await TonWallet.generate(); // store `mnemonic` securely!
 * // ... fund wallet.address with TON/USDT ...
 * const client = MyStarsClient.production(process.env.MYSTARS_API_KEY!);
 * const rpc = new ToncenterRpc({ endpoint: "https://toncenter.com/api/v2/jsonRPC", apiKey: process.env.TONCENTER_KEY });
 * // a stable idempotencyKey is REQUIRED — derive it from your own order id (see fulfill's retry-hazard note)
 * const order = await fulfill(client, wallet, { type: "stars", recipient: { username: "durov" }, quantity: 100 }, { rpc, idempotencyKey: `order-${myOrderId}` });
 * ```
 */

export { TonWallet, WalletError, InsufficientBalanceError, type CreateTransferArgs } from "./wallet.js";
export {
  OrderPayer,
  DEFAULT_USDT_MASTER,
  DEFAULT_JETTON_GAS_TON,
  type PayOrderOptions,
  type PayOrderResult,
  type PlannedMessage,
} from "./payer.js";
export { ToncenterRpc, type TonRpc, type ToncenterRpcOptions } from "./rpc.js";
export { fulfill, orderIdFromError, type FulfillClient, type FulfillOptions, type ErrorWithOrderId } from "./fulfill.js";
