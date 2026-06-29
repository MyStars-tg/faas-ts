#!/usr/bin/env node
/**
 * mystars-faas — CLI for the MyStars FaaS API.
 *
 * Auth: pass `--api-key` or set `MYSTARS_API_KEY`. Every command prints JSON to stdout.
 */

import { Command } from "commander";
import { MyStarsClient, type Currency, type OrderStatus, type OrderType } from "@mystars-tg/faas-sdk";
import {
  cmdCurrencies,
  cmdOrdersCancel,
  cmdOrdersCreate,
  cmdOrdersGet,
  cmdOrdersList,
  cmdPricing,
  cmdProducts,
  cmdRecipientCheck,
  cmdWatch,
  cmdWebhookVerify,
  resolveWebhookSecret,
  type CliIO,
} from "./commands.js";

const program = new Command();
const io: CliIO = { out: (s) => console.log(s), err: (s) => console.error(s) };

program
  .name("mystars-faas")
  .description("CLI for the MyStars FaaS API (Telegram Stars & Premium for any @username).")
  .version("0.1.3")
  .option("--api-key <key>", "tenant API key (or set MYSTARS_API_KEY)");

function makeClient(): MyStarsClient {
  const opts = program.opts<{ apiKey?: string }>();
  const apiKey = opts.apiKey ?? process.env.MYSTARS_API_KEY;
  if (!apiKey) {
    io.err("error: an API key is required (--api-key <key> or MYSTARS_API_KEY)");
    process.exit(1);
  }
  return MyStarsClient.production(apiKey);
}

function fail(msg: string): never {
  io.err(`error: ${msg}`);
  process.exit(1);
}
const num = (v: string | undefined, name: string): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) fail(`--${name} must be a number, got "${v}"`);
  return n;
};
function asType(t: string): OrderType {
  if (t !== "stars" && t !== "premium") fail(`--type must be "stars" or "premium", got "${t}"`);
  return t;
}

program
  .command("pricing")
  .description("quote a price")
  .requiredOption("--type <type>", "stars | premium")
  .option("--quantity <n>", "stars quantity")
  .option("--months <n>", "premium months (3|6|12)")
  .option("--currency <c>", "ton | usdt_ton")
  .action((o) =>
    cmdPricing(makeClient(), { type: asType(o.type), quantity: num(o.quantity, "quantity"), months: num(o.months, "months"), currency: o.currency as Currency | undefined }, io),
  );

program.command("products").description("list the product catalog").action(() => cmdProducts(makeClient(), io));
program.command("currencies").description("list payment currencies").action(() => cmdCurrencies(makeClient(), io));

program
  .command("recipient-check")
  .description("resolve a @username and check eligibility")
  .argument("<username>")
  .requiredOption("--type <type>", "stars | premium")
  .option("--months <n>", "premium months")
  .action((username, o) => cmdRecipientCheck(makeClient(), { type: asType(o.type), username, months: num(o.months, "months") }, io));

const orders = program.command("orders").description("manage orders");
orders
  .command("create")
  .requiredOption("--type <type>", "stars | premium")
  .requiredOption("--recipient <username>")
  .option("--quantity <n>")
  .option("--months <n>")
  .option("--currency <c>", "ton | usdt_ton")
  .option("--callback <url>", "webhook callback_url")
  .option("--pay", "also print a payable request (deeplink / QR / TON Connect)")
  .action((o) =>
    cmdOrdersCreate(
      makeClient(),
      { type: asType(o.type), recipient: o.recipient, quantity: num(o.quantity, "quantity"), months: num(o.months, "months"), currency: o.currency as Currency | undefined, callback: o.callback, pay: o.pay },
      io,
    ),
  );
orders.command("get").argument("<id>").action((id) => cmdOrdersGet(makeClient(), id, io));
orders
  .command("ls")
  .option("--status <status>")
  .option("--limit <n>")
  .action((o) => cmdOrdersList(makeClient(), { status: o.status as OrderStatus | undefined, limit: num(o.limit, "limit") }, io));
orders.command("cancel").argument("<id>").action((id) => cmdOrdersCancel(makeClient(), id, io));

program.command("watch").description("poll an order until it's terminal").argument("<id>").action((id) => cmdWatch(makeClient(), id, io));

program
  .command("webhook-verify")
  .description("verify an X-Faas-Signature over a raw body")
  .option(
    "--secret <secret>",
    "tenant webhook secret (PREFER MYSTARS_WEBHOOK_SECRET — a secret on the command line leaks into `ps` and shell history)",
  )
  .requiredOption("--body <json>")
  .requiredOption("--signature <sig>")
  .action((o) =>
    cmdWebhookVerify({ secret: resolveWebhookSecret(o.secret), body: o.body, signature: o.signature }, io),
  );

program.parseAsync(process.argv).catch((e: unknown) => {
  io.err(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
