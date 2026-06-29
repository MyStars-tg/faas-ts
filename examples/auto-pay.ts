/**
 * Self-custody auto-pay — generate a wallet, then create → pay → wait in one call.
 *
 * ⚠️ MOVES REAL FUNDS. fulfill() broadcasts an on-chain payment from YOUR wallet.
 * SELF-CUSTODY: the key lives ONLY in this process's memory — the SDK never persists,
 * logs, or transmits it. MyStars never holds your keys.
 *
 * Run:
 *   MYSTARS_API_KEY=faas_… TONCENTER_KEY=… npx tsx examples/auto-pay.ts
 */
import { MyStarsClient } from "@mystars-tg/faas-sdk";
import { TonWallet, ToncenterRpc, fulfill, orderIdFromError } from "@mystars-tg/faas-wallet";

async function main(): Promise<void> {
  const apiKey = process.env.MYSTARS_API_KEY;
  if (!apiKey) throw new Error("set MYSTARS_API_KEY");

  const client = MyStarsClient.production(apiKey);

  // Reuse the SAME funded wallet across runs via MYSTARS_WALLET_MNEMONIC.
  // FIRST run (no env var): we generate a wallet, print its address + mnemonic, and STOP
  // without paying. Fund the address, export the mnemonic, then re-run to actually pay.
  // The mnemonic is shown once and is never persisted by the SDK — store it securely.
  const mnemonicEnv = process.env.MYSTARS_WALLET_MNEMONIC?.trim();
  if (!mnemonicEnv) {
    const generated = await TonWallet.generate();
    console.log("No MYSTARS_WALLET_MNEMONIC set — generated a new wallet. To pay:");
    console.log("  1) fund this address with TON:", generated.wallet.address);
    console.log(`  2) export MYSTARS_WALLET_MNEMONIC="${generated.mnemonic.join(" ")}"`);
    console.log("  3) re-run this script.");
    return;
  }
  const wallet = await TonWallet.fromMnemonic(mnemonicEnv.split(/\s+/));
  console.log("using funded wallet:", wallet.address);

  const rpc = new ToncenterRpc({
    endpoint: "https://toncenter.com/api/v2/jsonRPC",
    apiKey: process.env.TONCENTER_KEY,
  });

  // A STABLE idempotencyKey is REQUIRED — fulfill() throws without one. Derive it from
  // your own order id so a retry never creates or pays a second order (double-spend).
  const myOrderId = process.env.MY_ORDER_ID ?? "demo-0001";

  try {
    const order = await fulfill(
      client,
      wallet,
      { type: "stars", recipient: { username: "durov" }, quantity: 100 },
      { rpc, idempotencyKey: `order-${myOrderId}` },
    );
    console.log("delivered:", order.status, order.purchase_tx ?? "");
  } catch (err) {
    // If the throw happened AFTER the order existed, the payment may already be in
    // flight — re-attach via the order id instead of re-running fulfill().
    const orderId = orderIdFromError(err);
    if (orderId) {
      const final = await client.waitForOrder(orderId);
      console.log("re-attached:", final.status, final.purchase_tx ?? "");
      return;
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
