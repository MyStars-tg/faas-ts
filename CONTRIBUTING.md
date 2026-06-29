# Contributing

Thanks for your interest in the MyStars FaaS TypeScript SDK!

## This repo is a mirror

`github.com/mystars-tg/faas-ts` is an **automatic mirror** of the official MyStars FaaS SDK. The
`main` branch here is **force-pushed** whenever SDK changes land upstream, so **pull requests
opened against this mirror cannot be merged** — they would be overwritten on the next sync.

**Please contribute via issues instead:**

- 🐛 **Found a bug?** Open an issue with a minimal repro (SDK version, Node/runtime, the call you
  made, and what happened vs. what you expected). See the issue templates.
- 💡 **Want a feature or a change?** Open an issue describing the use case. If you have a patch,
  paste the diff or a code sketch in the issue — the maintainers will apply it upstream and
  it will flow back to this mirror, with credit.

## Running the SDK locally

```bash
git clone https://github.com/mystars-tg/faas-ts
cd faas-ts
npm ci
npm run build          # tsup, dual ESM + CJS, all 3 packages
npm run typecheck && npm run lint && npx vitest run
```

The cross-language golden vectors in [`contract/`](contract/) are asserted by the tests, so behaviour
stays provably identical across the TypeScript and Python SDKs and provably matches the server.

## Conventions

- TypeScript strict mode, zero-warning ESLint, dual ESM + CJS via tsup.
- **Money is never a float** — amounts stay as decimal strings / `bigint` micro-units end to end.
- **Keys never leave the partner** — the optional wallet is self-custody; it holds keys only in
  process memory and never logs, persists, or transmits them.

## Security

Please report vulnerabilities privately — see [SECURITY.md](SECURITY.md). Do **not** open a public
issue for a security report.

## License

By contributing you agree your contribution is licensed under the [MIT License](LICENSE).
