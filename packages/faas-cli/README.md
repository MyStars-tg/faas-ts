# @mystars-tg/faas-cli

[![npm](https://img.shields.io/npm/v/@mystars-tg/faas-cli.svg)](https://www.npmjs.com/package/@mystars-tg/faas-cli) [![license](https://img.shields.io/npm/l/@mystars-tg/faas-cli.svg)](LICENSE)

Command-line tool for the MyStars FaaS API — quoting, recipient checks, order management, payment
links, and webhook verification. Great for onboarding, support, and quick smoke tests.

📖 API reference: **[mystars.tg/docs](https://mystars.tg/docs)**.

## Use it

```bash
# No install needed:
npx @mystars-tg/faas-cli --help

# Or install globally:
npm install -g @mystars-tg/faas-cli
```

Authenticate with `--api-key <key>` or `MYSTARS_API_KEY`. Every command prints JSON to stdout.

```bash
export MYSTARS_API_KEY=faas_...

mystars-faas pricing --type stars --quantity 100 --currency ton
mystars-faas products
mystars-faas currencies
mystars-faas recipient-check durov --type stars
mystars-faas orders create --type stars --recipient durov --quantity 100 --pay   # prints a payable deeplink/QR/TON Connect
mystars-faas orders get <order-id>
mystars-faas orders ls --status delivered --limit 50
mystars-faas orders cancel <order-id>
mystars-faas watch <order-id>                                                     # poll until terminal

# webhook-verify: PREFER the env var — a secret on the command line leaks into `ps` + shell history.
export MYSTARS_WEBHOOK_SECRET=...
mystars-faas webhook-verify --body '<raw-json>' --signature <X-Faas-Signature>
```

`webhook-verify` runs entirely offline — handy for debugging a signature locally. The webhook secret
comes from `MYSTARS_WEBHOOK_SECRET` (preferred) or `--secret <secret>`; the env var **wins** when both
are set, because a secret passed on the command line is visible in the process list (`ps`) and your
shell history. The CLI never holds keys or moves funds; `orders create --pay` only **prints** a payment
request you can pay from your own wallet (see `@mystars-tg/faas-wallet` for programmatic signing +
broadcasting).
