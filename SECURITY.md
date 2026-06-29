# Security Policy

The MyStars FaaS SDK is used to move real value (TON / USDT payments for Telegram Stars & Premium),
so we take security reports seriously.

## Reporting a vulnerability

**Do not open a public GitHub issue for a security report.**

Report privately via the MyStars bot — [@my_stars_tg_bot](https://t.me/my_stars_tg_bot) → **Support**
— and state clearly that it is a security report. Please include:

- the affected package + version (`@mystars-tg/faas-sdk` / `-wallet` / `-cli`),
- a description of the issue and its impact,
- a minimal proof of concept if you have one.

We aim to acknowledge within a few business days and will keep you updated on the fix. Please give us
a reasonable window to remediate before any public disclosure.

## Scope — what we especially want to hear about

- Anything that could leak, log, persist, or transmit a wallet key or mnemonic from `@mystars-tg/faas-wallet`.
- A webhook-signature verification bypass (`verifyWebhookSignature` / `constructEvent`).
- Incorrect money math (markup / amount / cent rounding) that could over- or under-charge.
- Idempotency-key handling that could cause a duplicate order / double-spend.

## Supported versions

The SDK is pre-1.0; only the **latest published version** is supported. Please upgrade before reporting.
