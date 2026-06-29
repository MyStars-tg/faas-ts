# TypeScript examples

Runnable examples for [`@mystars-tg/faas-sdk`](../packages/faas-sdk) and
[`@mystars-tg/faas-wallet`](../packages/faas-wallet). Each file is self-contained.

| File | What it shows | Moves funds? |
|---|---|---|
| [`quickstart.ts`](quickstart.ts) | quote → check recipient → create order → **non-custodial** payment request → track | No (prints a payment request) |
| [`auto-pay.ts`](auto-pay.ts) | **self-custody** wallet: `fulfill()` create → pay → wait, with crash-safe re-attach | **Yes** — broadcasts a real on-chain payment |
| [`webhook-server.ts`](webhook-server.ts) | verify `X-Faas-Signature` over the raw body + dedup on `order_id` (stdlib `http`) | No |

## Run

Get an API key in [@my_stars_tg_bot](https://t.me/my_stars_tg_bot) → **API access**, then:

```bash
# quickstart + webhook-server need only the core; auto-pay also needs @mystars-tg/faas-wallet:
npm install @mystars-tg/faas-sdk
MYSTARS_API_KEY=faas_… npx tsx quickstart.ts
```

`auto-pay.ts` also needs a funded TON wallet and a `TONCENTER_KEY`; `webhook-server.ts`
needs `MYSTARS_WEBHOOK_SECRET`.

> These examples are typechecked in CI against the SDK source (`examples/tsconfig.json`),
> so they never drift from the real API. Run locally from the repo root:
> `npm run build && npx tsc -p examples/tsconfig.json`.
