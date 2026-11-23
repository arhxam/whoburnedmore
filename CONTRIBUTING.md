# Contributing to whoburnedmore

Thanks for taking the time to contribute! Issues and pull requests are welcome.

This repository is a generated mirror of the production CLI, so a merged change is
re-applied upstream and then synced back here. Keep pull requests focused on one change;
that makes them much easier to review and carry over.

## Development

You'll need Node.js 20+ (22.5+ also runs the SQLite-backed integration tests).

```bash
npm install     # install dependencies
npm run lint    # strict TypeScript check
npm test        # run the tests (vitest)
npm run build   # bundle src/index.ts to dist/index.js
node dist/index.js --dry-run   # print what would be sent, send nothing
```

Use `--dry-run` or `--local` while developing. Point a test run at your own server with
`WHOBURNEDMORE_API`; never test against the production API with fabricated usage.

## How the CLI handles data

The CLI reads local agent logs and, on a normal run, **uploads daily aggregate numbers**
(date, tool, model, token counts, estimated cost, plus optional per-session and per-tool
rollups) to whoburnedmore.com. It never uploads prompts, code, file contents or file paths.
`--local` makes no network calls at all. See the [README](./README.md) for the full list.

## Ground rules

- **No new data leaves the machine without discussion.** Open an issue before adding a
  network call, a new uploaded field, telemetry, or analytics.
- **Never estimate usage you can't read.** A new source needs a real local record of
  per-request or per-day tokens. Don't infer usage from quotas, prices or activity.
- **Keep dependencies minimal.** Runtime dependencies are exact-pinned. Prefer the
  standard library, and explain any new dependency in the pull request.
- **Add a test.** New readers, aggregation or pricing logic need tests in [`test/`](./test),
  using synthetic fixtures only. Never commit real transcripts, prompts or account data.
- **Match the style.** Run `npm run lint` and `npm test` before opening a pull request.

## Good first issues

- Add or correct a model-family price fallback in [`src/pricing.ts`](./src/pricing.ts).
  The per-model table is generated from LiteLLM and refreshed at runtime, so don't edit
  `src/pricing-data.generated.ts` by hand.
- Read a new coding agent's usage. The [README](./README.md#supported-sources) lists
  what's covered today. Many agents are read through
  [ccusage](https://github.com/ccusage/ccusage), so support added there often needs only
  a small change here.
- Improve the `--local` HTML dashboard.

## Reporting bugs

Open an issue with your Node version, OS, CLI version (`npx whoburnedmore version`) and the
exact command you ran. Never paste prompts, transcripts or anything sensitive. The token
counts from `--dry-run` are plenty.
