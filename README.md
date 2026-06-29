<div align="center">

<img src="assets/banner.svg" alt="whoburnedmore — see how many tokens your AI coding agents really burned" width="100%" />

<br/><br/>

<p align="center">
  <b>Find out who burned more.</b><br/>
  Submit your AI coding-agent token usage to the public leaderboard.
</p>

<br/>

<!-- Row 1: status -->
<p align="center">
  <a href="https://github.com/amiinwani/whoburnedmore.com/actions/workflows/ci.yml">
    <img alt="CI" src="https://github.com/amiinwani/whoburnedmore.com/actions/workflows/ci.yml/badge.svg?style=flat-square" />
  </a>
  &nbsp;
  <a href="https://www.npmjs.com/package/whoburnedmore">
    <img alt="npm version" src="https://img.shields.io/npm/v/whoburnedmore?style=flat-square&color=cb3837&logo=npm&logoColor=white" />
  </a>
  &nbsp;
  <a href="https://www.npmjs.com/package/whoburnedmore">
    <img alt="npm downloads" src="https://img.shields.io/npm/dm/whoburnedmore?style=flat-square&color=cb3837&logo=npm&logoColor=white&label=downloads%2Fmo" />
  </a>
  &nbsp;
  <a href="https://github.com/amiinwani/whoburnedmore.com/blob/main/LICENSE">
    <img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square" />
  </a>
</p>

<!-- Row 2: environment -->
<p align="center">
  <a href="https://nodejs.org">
    <img alt="Node ≥20" src="https://img.shields.io/badge/node-%E2%89%A520-339933?style=flat-square&logo=node.js&logoColor=white" />
  </a>
  &nbsp;
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white" />
  &nbsp;
  <img alt="zero runtime deps" src="https://img.shields.io/badge/runtime%20deps-0-success?style=flat-square" />
  &nbsp;
  <img alt="macOS" src="https://img.shields.io/badge/macOS-✓-000000?style=flat-square&logo=apple&logoColor=white" />
  &nbsp;
  <img alt="Linux" src="https://img.shields.io/badge/Linux-✓-FCC624?style=flat-square&logo=linux&logoColor=black" />
  &nbsp;
  <img alt="Windows" src="https://img.shields.io/badge/Windows-✓-0078D4?style=flat-square&logo=windows&logoColor=white" />
</p>

<!-- Row 3: project vibe -->
<p align="center">
  <a href="https://whoburnedmore.com">
    <img alt="Leaderboard" src="https://img.shields.io/badge/🔥_leaderboard-whoburnedmore.com-ff8a3d?style=flat-square" />
  </a>
  &nbsp;
  <img alt="privacy: local-first" src="https://img.shields.io/badge/privacy-local--first-brightgreen?style=flat-square&logo=shield&logoColor=white" />
  &nbsp;
  <img alt="zero telemetry" src="https://img.shields.io/badge/telemetry-zero-brightgreen?style=flat-square" />
  &nbsp;
  <a href="https://x.com/whoburnedmore">
    <img alt="X / Twitter" src="https://img.shields.io/badge/@whoburnedmore-000000?style=flat-square&logo=x&logoColor=white" />
  </a>
</p>

<br/>

```bash
npx whoburnedmore
```

<sub>No install. No sign-up. Zero dependencies. Reads your local logs — sends only daily totals.</sub>

</div>

---

## What is this?

`whoburnedmore` is a **local-first CLI** that reads your AI coding-agent usage logs — Claude Code, Codex, Gemini CLI, Copilot, Cursor, and more — counts every token, prices it against a transparent table, and posts **only your daily totals** to a public leaderboard at [whoburnedmore.com](https://whoburnedmore.com).

Your prompts, code, file paths, and project names **never leave your machine**. This isn't a promise in a privacy policy — the [zero-network test](#-trust-but-verify) enforces it on every CI run.

> **Prefer 100% offline?** Run `npx whoburnedmore --local` to build a self-contained HTML dashboard on your machine and upload nothing, ever.

---

## The output

```
🔥 whoburnedmore — your local AI token burn report
────────────────────────────────────────────────────────

  1.82B tokens burned   $3,410.00 est.
  12,704 assistant messages · 18 active days · 2026-05-29 → 2026-06-15

  By model
    ████████░░░░░░░░░░  claude-opus-4-8       1.10B     $2,512.40
    █████░░░░░░░░░░░░░  claude-sonnet-4-6     512.0M      $640.10
    ██░░░░░░░░░░░░░░░░  claude-haiku-4-5      210.0M       $36.20

  By project
    ███████░░░░░░░░░░░  api                   903.0M    $1,640.00
    ████░░░░░░░░░░░░░░  web-app               540.0M      $980.00
    ██░░░░░░░░░░░░░░░░  infra                 377.0M      $790.00

  Prompt cache   97.4% read-hit rate  (1.71B cached reads)

────────────────────────────────────────────────────────
  100% local · nothing left your machine.
  Compare on the public board → https://whoburnedmore.com
```

---

## Supported agents

<div align="center">

| Agent                                                                                                        | Source                                 |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| ![Claude Code](https://img.shields.io/badge/Claude%20Code-✓-cc785c?style=flat-square)                        | `~/.claude/projects` JSONL transcripts |
| ![Codex](https://img.shields.io/badge/OpenAI%20Codex-✓-412991?style=flat-square)                             | `~/.codex/sessions` JSONL transcripts  |
| ![Gemini CLI](https://img.shields.io/badge/Gemini%20CLI-✓-4285F4?style=flat-square)                          | via `ccusage`                          |
| ![Cursor](https://img.shields.io/badge/Cursor-✓-000000?style=flat-square)                                    | `state.vscdb` → Cursor dashboard API   |
| ![GitHub Copilot](https://img.shields.io/badge/Copilot-✓-24292e?style=flat-square)                           | via `ccusage`                          |
| ![OpenCode](https://img.shields.io/badge/OpenCode-✓-0ea5e9?style=flat-square)                                | via `ccusage`                          |
| ![Amp](https://img.shields.io/badge/Amp%20%7C%20Droid%20%7C%20Goose%20%7C%20more-✓-6b7280?style=flat-square) | via `ccusage` (15+ sources)            |

</div>

---

## Commands

```bash
npx whoburnedmore                # submit + land on the leaderboard, open your dashboard
npx whoburnedmore --local        # build the dashboard locally, upload nothing
npx whoburnedmore --dry-run      # print exactly what would be sent, send nothing
npx whoburnedmore --no-submit    # collect locally, send nothing

npx whoburnedmore private        # hide your dashboard from the leaderboard
npx whoburnedmore public         # put it back
npx whoburnedmore remove         # delete your dashboard and all its data

npx whoburnedmore status         # check background-sync health
npx whoburnedmore install-sync   # turn on 15-minute background sync
npx whoburnedmore uninstall-sync # turn off the background sync
```

After your first run a background sync keeps your leaderboard page fresh every 15 minutes (`uninstall-sync` to stop). The installed job always runs the latest published package, so future fixes are picked up automatically.

---

## How it works

```
┌──────────────────────────────────────────────────────────────────┐
│                          LOCAL MACHINE                           │
│                                                                  │
│   ┌──────────────────────┐    ┌────────────────────────────┐     │
│   │    Coding Agents     │    │  Claude Code / Codex JSONL │     │
│   │  Claude · Gemini     │    │       ~/.claude/projects   │     │
│   │  Cursor · Copilot…   │    │       ~/.codex/sessions    │     │
│   └──────────┬───────────┘    └─────────────┬──────────────┘     │
│              │  (via ccusage)               │  (streaming scan)  │
│              ▼                              ▼                    │
│   ┌──────────────────────────────────────────────────────────┐   │
│   │                   whoburnedmore CLI                      │   │
│   │                                                          │   │
│   │   1. Collect & map daily usage data  (concurrent)        │   │
│   │   2. Deduplicate overlapping windows                     │   │
│   │   3. Estimate costs via local pricing table              │   │
│   │   4. Cap payload (20k daily rows / 10k session rows)     │   │
│   │                                                          │   │
│   └───────────────────────────┬──────────────────────────────┘   │
│                               │                                  │
│         --local (offline) ◄───┤───► HTTPS anonymous POST        │
│         Local HTML dashboard  │                                  │
└───────────────────────────────┼──────────────────────────────────┘
                                ▼
                ┌───────────────────────────────┐
                │      api.whoburnedmore.com    │
                │     Public Leaderboard API    │
                └───────────────────────────────┘
```

**Collection** (`src/collect.ts`) runs everything concurrently: a `ccusage` broker for 15+ agents, a streaming JSONL transcript analyzer (`src/attribution.ts`) with a 12-second hard deadline, and a Cursor SQLite integrator (`src/cursor.ts`) that calls Cursor's dashboard API for usage not stored locally.

**Identity** — on first run the CLI generates a cryptographically secure 32-byte hex `anonKey` written to `~/.config/whoburnedmore/config.json` with `0600` permissions via atomic temp-rename. This is your only identity. No sign-up required.

**Background sync** runs on native schedulers:

| Platform       | Mechanism                                                              |
| -------------- | ---------------------------------------------------------------------- |
| macOS          | `launchd` plist · `~/Library/LaunchAgents` · `ProcessType: Background` |
| Linux          | `systemd` user timer, or cron fallback                                 |
| Windows        | `schtasks` scheduled task                                              |
| Container / VM | `whoburnedmore daemon` (foreground)                                    |

---

## What leaves your machine

<div align="center">

| ✅ Sent                               | ❌ Never sent                |
| ------------------------------------- | ---------------------------- |
| Date                                  | Prompts or responses         |
| Tool name & model                     | Source code or file contents |
| Token counts (input / output / cache) | File paths or project names  |
| Estimated USD cost                    | Workspace or repo names      |
| Session count (optional)              | Conversation titles          |

</div>

---

## 🔒 Trust but verify

The `--local` flag disables all network calls. But talk is cheap — a committed [`test/zero-network.test.ts`](./test/zero-network.test.ts) **greps both the TypeScript source and the compiled `dist/` bundle** for `fetch`, raw sockets (`node:net` / `tls` / `dgram`), `WebSocket`, and any `http(s)://` literal on every CI push. A regression that phones home fails the build.

```
✓ source: no fetch / http / socket calls found
✓ bundle: no fetch / http / socket calls found
```

---

## Configuration

| Variable                   | Description                            |
| -------------------------- | -------------------------------------- |
| `WHOBURNEDMORE_API`        | Override the leaderboard API endpoint  |
| `WHOBURNEDMORE_WEB`        | Override the web dashboard origin      |
| `WHOBURNEDMORE_CONFIG_DIR` | Config, credentials, and log directory |
| `CLAUDE_CONFIG_DIR`        | Root path for Claude Code transcripts  |

---

## Development

```bash
# Prerequisites: Node.js 20+

git clone https://github.com/amiinwani/whoburnedmore.com.git
cd whoburnedmore.com

npm install       # install deps + build
npm test          # Vitest suite (includes zero-network check)
npm run lint      # TypeScript strict check
npm run build     # compile → dist/cli.js (single bundle, zero runtime deps)
npm start         # == node dist/cli.js
```

Or run straight from GitHub without cloning:

```bash
npx github:amiinwani/whoburnedmore.com
```

---

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a PR. Bug reports and feature requests go in [Issues](https://github.com/amiinwani/whoburnedmore.com/issues).

---

## License

Licensed under the **Apache License 2.0**. See [LICENSE](./LICENSE) for the full text.

---

<div align="center">
  <sub>
    Built by <a href="https://x.com/whoburnedmore">@whoburnedmore</a>
    &nbsp;·&nbsp;
    <a href="https://whoburnedmore.com/privacy">Privacy</a>
    &nbsp;·&nbsp;
    <a href="https://whoburnedmore.com">whoburnedmore.com</a>
  </sub>
</div>
