# MyStars FaaS — TypeScript / JavaScript SDK

Official TypeScript/JavaScript SDK for the **MyStars FaaS** public B2B API — buy Telegram **Stars** &
**Premium** for any `@username`, paid in **TON** or **USDT (TON)**.

- 📖 **API reference:** [mystars.tg/docs](https://mystars.tg/docs) — interactive OpenAPI portal
- 🔑 **Get an API key:** [@my_stars_tg_bot](https://t.me/my_stars_tg_bot) → **API access**

> This repository is an **automatic mirror** of the official MyStars FaaS SDK, published for
> distribution. Changes are made upstream and synced here, kept atomic with the OpenAPI contract.

## Packages

| Package | What it does | Runtime |
|---|---|---|
| [`@mystars-tg/faas-sdk`](packages/faas-sdk/README.md) | Core client — HTTP + retry/idempotency, typed errors, pagination, order tracking, webhook verification, retail markup, **non-custodial** invoice builders | Node ≥18, Deno, Bun, Cloudflare Workers, browser (**zero crypto deps**) |
| [`@mystars-tg/faas-wallet`](packages/faas-wallet/README.md) | **Opt-in** TON wallet + payer — generate/import a wallet, sign + broadcast a payment from **your own** wallet, one-call `fulfill()` | Node only (`@ton/*`) |
| [`@mystars-tg/faas-cli`](packages/faas-cli/README.md) | The `mystars-faas` CLI — `pricing`, `orders`, `watch`, `webhook-verify`; holds no keys | Node |

## Install & 60-second quickstart

```bash
npm install @mystars-tg/faas-sdk
```

```ts
import { MyStarsClient } from "@mystars-tg/faas-sdk";

const client = MyStarsClient.production(process.env.MYSTARS_API_KEY!);

// 1. Quote → 2. create (pass a STABLE idempotencyKey from your own order id) → 3. pay → 4. track
const quote = await client.getPricing({ type: "stars", quantity: 100, payment_currency: "ton" });
const order = await client.createOrder(
  { type: "stars", recipient: { username: "durov" }, quantity: 100, payment_currency: "ton" },
  { idempotencyKey: `order-${myOrderId}` },
);
// Pay order.payment.amount → order.payment.pay_to_address, on-chain comment = order.payment.memo.
const finished = await client.waitForOrder(order.order_id, { onUpdate: (o) => console.log(o.status) });
```

Each package's README has the full feature walkthrough (errors + recovery, pagination, webhooks +
Express/Fastify adapters, retail markup, paying an order via the self-custody wallet or non-custodially).

## Documentation

- Per-package READMEs: [faas-sdk](packages/faas-sdk/README.md) · [faas-wallet](packages/faas-wallet/README.md) · [faas-cli](packages/faas-cli/README.md)
- **Runnable examples:** [`examples/`](examples/) — quickstart, self-custody auto-pay, webhook receiver
- **Full API reference** (every public method & function): [api-typescript.md](../../docs/sdk/api-typescript.md)
- Topic guides: [webhook signature contract](../../docs/sdk/webhooks.md) · [retail markup](../../docs/sdk/markup.md) · [wallets & paying](../../docs/sdk/wallet.md) · [versioning & distribution](../../docs/sdk/versioning.md)
- Cross-language parity fixtures: [`../contract/`](../contract/) · Changelog: [CHANGELOG.md](CHANGELOG.md)

> Compatible with FaaS API **v1.9.0** — pinned in `contract/CONTRACT_VERSION` and exposed at
> runtime as `CONTRACT_VERSION` from `@mystars-tg/faas-sdk`.

## Develop

```bash
cd faas-ts && npm ci
npm run build          # tsup, dual ESM + CJS, all 3 packages
npm run typecheck && npm run lint && npx vitest run
```

Runs in CI as `test:sdk:ts` (build → typecheck → zero-warnings lint → vitest). The cross-language
golden vectors in [`../contract/`](../contract/) are asserted here and in the Python SDK, so behaviour
is provably identical across languages and provably matches the server.

## License

[MIT](LICENSE) © MyStars.tg
