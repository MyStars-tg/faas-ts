# @mystars-tg/faas-wallet

[![npm](https://img.shields.io/npm/v/@mystars-tg/faas-wallet.svg)](https://www.npmjs.com/package/@mystars-tg/faas-wallet) [![license](https://img.shields.io/npm/l/@mystars-tg/faas-wallet.svg)](LICENSE)

Opt-in TON wallet + payer for [`@mystars-tg/faas-sdk`](https://www.npmjs.com/package/@mystars-tg/faas-sdk).
**Node only.** Generate or import a TON wallet, read balances, and pay a FaaS order invoice (TON or
USDT) from **your own** wallet.

📖 API reference: **[mystars.tg/docs](https://mystars.tg/docs)** · core client: [`@mystars-tg/faas-sdk`](https://www.npmjs.com/package/@mystars-tg/faas-sdk).

> **Key custody:** keys live only in process memory. This package never writes a mnemonic or secret
> key to disk, never logs it, and never sends it anywhere. `generate()` returns the mnemonic exactly
> once — storing it securely is your responsibility. Payments move **your** funds from **your** wallet
> to the MyStars treasury invoice; the SDK never touches your keys beyond signing in memory.

## Install

```bash
npm install @mystars-tg/faas-sdk @mystars-tg/faas-wallet
```

## One-call fulfilment

```ts
import { MyStarsClient } from "@mystars-tg/faas-sdk";
import { TonWallet, ToncenterRpc, fulfill } from "@mystars-tg/faas-wallet";

// 1. Create (or import) a funding wallet and fund its address with TON/USDT.
const { wallet, mnemonic } = await TonWallet.generate(); // STORE `mnemonic` securely
console.log("Fund this address:", wallet.address);

// 2. Wire a client + an RPC.
const client = MyStarsClient.production(process.env.MYSTARS_API_KEY!);
const rpc = new ToncenterRpc({ endpoint: "https://toncenter.com/api/v2/jsonRPC", apiKey: process.env.TONCENTER_KEY });

// 3. create → pay → wait, in one call.
//    A STABLE idempotencyKey is REQUIRED — see the retry-hazard note below.
const order = await fulfill(
  client, wallet,
  { type: "stars", recipient: { username: "durov" }, quantity: 100 },
  { rpc, idempotencyKey: `order-${myOrderId}` },
);
console.log(order.status, order.purchase_tx);
```

> Set `MYSTARS_API_KEY` and `TONCENTER_KEY` in your environment, or load a `.env` with Node's
> built-in flag — `node --env-file=.env app.js` (no extra dependency). Snippets use illustrative
> placeholders (`myOrderId`, `params`, …) — substitute your own values.

## ⚠️ Retry hazard — `fulfill()` moves real money

`fulfill()` broadcasts a **real on-chain payment**. A naive retry of a `fulfill` that already paid
would create a SECOND order and pay it AGAIN (double-spend). Two safeguards make retries safe, and the
first is **mandatory**:

1. **A stable `idempotencyKey` is required** (`opts.idempotencyKey`, or `createOptions.idempotencyKey`).
   Derive it from your own order id so re-running `fulfill` reuses the same key — the server returns the
   SAME order (idempotent replay) instead of minting a duplicate. `fulfill` throws a
   `MyStarsValidationError` before creating or paying if you omit it.
2. **It only broadcasts when the order still needs payment.** If the (replayed) order has already
   advanced past `awaiting_payment`, `fulfill` skips the payment and just waits — so a retry never
   double-pays an order whose first payment already landed.

If anything throws after the order exists, the error carries `order_id` — read it with the type-safe
`orderIdFromError(err)` accessor and re-attach instead of re-running `fulfill`:

```ts
import { fulfill, orderIdFromError } from "@mystars-tg/faas-wallet";

try {
  await fulfill(client, wallet, params, { rpc, idempotencyKey: `order-${myOrderId}` });
} catch (err) {
  const orderId = orderIdFromError(err);
  if (orderId) {
    // Payment may have been broadcast — re-attach, do NOT re-run fulfill.
    await client.waitForOrder(orderId); // resolves once the order is terminal
  }
  throw err;
}
```

## Step by step

```ts
import { TonWallet, OrderPayer, ToncenterRpc, DEFAULT_USDT_MASTER } from "@mystars-tg/faas-wallet";

const wallet = await TonWallet.fromMnemonic(mnemonic); // mnemonic from generate() / your secret store
const rpc = new ToncenterRpc({ endpoint: "https://toncenter.com/api/v2/jsonRPC" });

const balance = await wallet.getBalance(rpc);                      // nanoTON
const usdt = await wallet.getJettonBalance(rpc, DEFAULT_USDT_MASTER); // micro-USDT

const order = await client.createOrder({ type: "stars", recipient: { username: "durov" }, quantity: 100, payment_currency: "usdt_ton" });
await new OrderPayer(wallet).payOrder(order, { rpc }); // signs once + broadcasts
const final = await client.waitForOrder(order.order_id);
```

`TonWallet` currently creates **WalletContractV4** wallets — fund the `address` it produces. For a
custom signer (keys in an HSM, never in the SDK), build the TON Connect message with the core SDK's
`buildTonConnectMessages` instead and sign it yourself.
