# Changelog

All notable changes to the MyStars FaaS TypeScript SDK packages — `@mystars-tg/faas-sdk`,
`@mystars-tg/faas-wallet`, `@mystars-tg/faas-cli` (versioned together in this workspace) — are documented
here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the packages
adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The `CONTRACT_VERSION` each
release is built + verified against (the FaaS API `info.version`) is noted per entry — see
[docs/sdk/versioning.md](../../docs/sdk/versioning.md).

## [0.1.3] - 2026-06-29

_Built against FaaS API contract **v1.9.0** (unchanged). Bug-fix + docs patch._

### Fixed
- `@mystars-tg/faas-sdk`: `toNano` / `toMicro` / `decimalToUnits` now throw a domain
  `MyStarsValidationError` (with a clear "must be a decimal string" message) when called with a
  non-string amount — previously a `number` (reachable from plain JS) produced a raw
  `TypeError: amount.trimStart is not a function`. Money amounts are decimal **strings**; a JS
  `number` stays rejected on purpose (a float literal can carry binary rounding error).

### Docs
- `@mystars-tg/faas-sdk`: Quick start documents running with the key in the environment
  (`MYSTARS_API_KEY=… node app.js`) or via Node's built-in `node --env-file=.env`, and marks
  illustrative placeholders. Removed the stale `(upcoming)` label on `@mystars-tg/faas-wallet`
  (it is published). `toNano`/`toMicro`/`decimalToUnits` JSDoc now state **decimal string, not a
  number**.
- `@mystars-tg/faas-wallet`: README example imports + uses the exported `DEFAULT_USDT_MASTER`
  (was an undeclared `USDT_MASTER`), annotates the `mnemonic` source, and documents the
  `--env-file` run note.
- `@mystars-tg/faas-cli`: documented the `currencies` command in the README command list.

_The first published npm release. Built against FaaS API contract **v1.9.0**._

### Added
- `@mystars-tg/faas-sdk`: `MyStarsApiError.idempotencyKey` — on a failed `createOrder`, the thrown error
  carries the `Idempotency-Key` that was sent, so you can safely retry the **same** key (idempotent
  replay) instead of risking a duplicate order.
- `@mystars-tg/faas-wallet`: `orderIdFromError(err)` — a typed accessor for the `order_id` attached to a
  post-create `fulfill()` failure, so you re-attach (`waitForOrder`) instead of re-paying.
- `@mystars-tg/faas-cli`: `webhook-verify` reads the secret from `MYSTARS_WEBHOOK_SECRET` (preferred over
  `--secret`, which leaks via the process list / shell history).

### Changed
- `@mystars-tg/faas-wallet`: **`fulfill()` now requires a stable `idempotencyKey`** (or
  `createOptions.idempotencyKey`) and throws `MyStarsValidationError` without one. It also only
  broadcasts when the (possibly replayed) order is still `awaiting_payment`. Together these make a
  retried `fulfill()` safe against double-create + double-spend. **(Behavioural change for early users
  of `fulfill`.)**
- `@mystars-tg/faas-sdk`: the HTTP retry honours `Retry-After` only up to `maxDelayMs`, so a hostile or
  absurd header can no longer park the client for an unbounded time.
- Re-verified + re-pinned against FaaS API contract **v1.9.0** (was v1.8.2): the order payment window
  is now **1 hour** (was 15 min). `expires_at` is unchanged in shape and remains the authoritative
  deadline — no SDK code change; if you read `expires_at` (rather than assuming 15 min) nothing in
  your integration changes.

### Fixed
- `@mystars-tg/faas-sdk`: the response body is now read **inside** the request timeout/abort window — a
  stalled response body trips the timeout instead of hanging unbounded.
- `@mystars-tg/faas-sdk`: `applyRetailMarkup` throws on a `usdt_ton` quote with no `fee` breakdown
  (a real server response on cold-FX rows) instead of marking up the fee-inclusive amount.
- `@mystars-tg/faas-sdk`: `buildCommentPayload` and the jetton memo builder reject a comment that would
  overflow a single TON cell (>123 UTF-8 bytes) instead of emitting a corrupt payload.
- `@mystars-tg/faas-sdk`: invoice/transfer builders reject a non-positive (zero or negative) amount
  before constructing or signing anything.

### Security
- `@mystars-tg/faas-wallet`: documented + enforced that keys live only in process memory (never written,
  logged, or transmitted; redacted from `JSON.stringify` / `util.inspect`).
