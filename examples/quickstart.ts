/**
 * Quickstart — quote → check recipient → create order → non-custodial payment request.
 *
 * No funds move here: this only PRINTS a payment request that you (or your end-user's
 * wallet) pay from your own wallet. For programmatic paying see ./auto-pay.ts.
 *
 * Run:
 *   MYSTARS_API_KEY=faas_… npx tsx examples/quickstart.ts
 */
import { MyStarsClient, buildPaymentRequest } from "@mystars-tg/faas-sdk";

async function main(): Promise<void> {
  const apiKey = process.env.MYSTARS_API_KEY;
  if (!apiKey) throw new Error("set MYSTARS_API_KEY — get one in @my_stars_tg_bot → API access");

  const client = MyStarsClient.production(apiKey);

  // 1) Quote the all-in price (100 Stars for @durov, paid in TON).
  const quote = await client.getPricing({ type: "stars", quantity: 100, payment_currency: "ton" });
  console.log(`price: ${quote.amount} ${quote.currency}`);

  // 2) (optional) Confirm the recipient resolves and can receive the item.
  const check = await client.checkRecipient({ type: "stars", recipient: { username: "durov" } });
  if (!check.eligible) throw new Error(check.telegram_message ?? "recipient ineligible");

  // 3) Create the order. Use a STABLE idempotencyKey derived from your OWN order id so a
  //    retry (even after a crash) returns the SAME order instead of creating a duplicate.
  const myOrderId = process.env.MY_ORDER_ID ?? "demo-0001";
  const order = await client.createOrder(
    { type: "stars", recipient: { username: "durov" }, quantity: 100, payment_currency: "ton" },
    { idempotencyKey: `quickstart-${myOrderId}` },
  );

  // 4) Turn the order's payment block into something a wallet can pay. NON-CUSTODIAL:
  //    no keys are involved — you/your user sign in your own wallet.
  const pay = buildPaymentRequest(order.payment);
  console.log("order:", order.order_id);
  console.log("pay from your own wallet:", pay.tonDeeplink);

  // 5) Track the order to a terminal state (delivered / failed / reversed / expired).
  const final = await client.waitForOrder(order.order_id, {
    onUpdate: (o) => console.log("status:", o.status),
  });
  console.log("done:", final.status, final.purchase_tx ?? "");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
