<div align="center">
  <img src="assets/banner.svg" width="100%" alt="whoburnedmore — the public leaderboard for AI coding-agent token usage">
</div>

<br>

<div align="center">

[![npm](https://img.shields.io/npm/v/whoburnedmore?color=%23f97316&style=for-the-badge&label=npm%20version)](https://www.npmjs.com/package/whoburnedmore)
[![License: MIT](https://img.shields.io/badge/license-MIT-%23f97316?style=for-the-badge)](LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/whoburnedmore?color=%23f97316&style=for-the-badge&label=monthly%20downloads)](https://www.npmjs.com/package/whoburnedmore)
[![Node.js](https://img.shields.io/node/v/whoburnedmore?color=%23333333&style=for-the-badge&label=node)](package.json)

<br>

[![Verify this repo with Claude](https://img.shields.io/badge/%F0%9F%94%8D%20verify%20this%20repo-with%20Claude-000000?style=for-the-badge)][audit]

</div>

<br>

<div align="center">
  <img src="assets/leaderboard.jpg" width="92%" alt="whoburnedmore leaderboard — 629B combined burn, 103 indexed devs">
</div>

<br>

---

One command. Your AI token burn, ranked against every developer on the board.

```bash
npx whoburnedmore
```

`whoburnedmore` reads your local AI coding-agent usage files — Claude Code, Codex, Cursor, Gemini CLI, Copilot, and a dozen more — tallies tokens and estimated cost, and posts your daily totals to [whoburnedmore.com](https://whoburnedmore.com) so you get a shareable dashboard and a rank.

**Your first run signs you in.** The CLI opens a short approval page, then binds this machine to your account. Every run after that syncs automatically in the background.

> Prefer to stay fully offline? `npx whoburnedmore --local` builds an HTML report on your machine and uploads nothing.

<br>

<div align="center">

## 🛡️ Not sure it's safe to run? Have Claude check it first.

[![▶ Verify this repo with Claude](https://img.shields.io/badge/%F0%9F%94%8D%20VERIFY%20THIS%20REPO%20WITH%20CLAUDE%20%E2%86%92-000000?style=for-the-badge&labelColor=000000)][audit]

**[👉 Click to open Claude and audit this repository in one click 👈][audit]**

<sub>Opens a Claude chat that reads this repo's source and reports exactly what data the CLI collects, what leaves your machine, every server it talks to, and whether it could touch your code, prompts, or secrets — ending with a clear **go / no-go** verdict, *before you run anything.*</sub>

</div>

---

## What it reads

`whoburnedmore` uses [ccusage](https://github.com/ryoppippi/ccusage) under the hood to collect from every major agent log format in parallel:

<div align="center">

| Agent | Log source |
|---|---|
| **Claude Code** | `~/.claude/` transcripts (native reader) |
| **OpenAI Codex** | `~/.codex/` transcripts (native reader) |
| **Cursor** | Cursor session database |
| **GitHub Copilot** | Copilot usage logs |
| **Gemini CLI** | Gemini session logs |
| **OpenCode** | OpenCode logs |
| **Amp** | Amp logs |
| **Kimi CLI** | Kimi logs |
| **Qwen Code** | Qwen logs |
| **Kilo Code** | Kilo logs |
| **Goose** | Goose session files |
| **Hermes Agent** | Hermes logs |
| **Pi Agent** | Pi logs |
| **Codebuff** | Codebuff logs |
| **Droid / Openclaw** | Additional agent formats |

</div>

All sources run in parallel. The whole collection pass typically completes in under 15 seconds.

---

## Commands

<div align="center">

| Command | What it does |
|---|---|
| `npx whoburnedmore` | Sign in, collect, submit, open your dashboard |
| `npx whoburnedmore --local` | Build a local HTML dashboard — no upload, fully offline |
| `npx whoburnedmore --dry-run` | Print exactly what would be sent, send nothing |
| `npx whoburnedmore --no-submit` | Collect locally, skip the upload |
| `npx whoburnedmore --board=CODE` | Join a private friends board |
| `npx whoburnedmore --org=SLUG` | Submit to your organization's board |
| `npx whoburnedmore link --token=TOKEN` | Bind a server or VM to your account |
| `npx whoburnedmore daemon` | Keep syncing in the foreground (for containers) |
| `npx whoburnedmore install-sync` | Turn on 15-minute background sync |
| `npx whoburnedmore uninstall-sync` | Turn off background sync |
| `npx whoburnedmore private` | Hide your dashboard from the leaderboard |
| `npx whoburnedmore public` | Put it back |
| `npx whoburnedmore verify` | Delisted? Re-verify usage to get back on |
| `npx whoburnedmore remove` | Delete your dashboard and all data |
| `npx whoburnedmore status` | Check background-sync health and freshness |

</div>

After your first run, a background sync keeps your page current every 15 minutes. The installed job always pulls the latest published package, so future bug fixes apply automatically on the next tick.

---

## Privacy

`whoburnedmore` only ever sends **daily aggregate numbers**: date, tool name, model name, token counts, and estimated cost — plus optional per-session and per-tool rollups. It never sees your prompts, your code, your file paths, or any file content.

<table>
<tr>
<td width="50%">

**What leaves your machine**

- Dates (day-level granularity)
- Tool and model names
- Token counts (input / output / cache)
- Estimated cost in USD
- Optional per-session rollups

</td>
<td width="50%">

**What never leaves your machine**

- Prompt text or conversation content
- Code you wrote or generated
- File names or file paths
- Project names or repository paths
- Any personal data from your environment

</td>
</tr>
</table>

Run `private` to hide from the leaderboard, `remove` to delete all stored data, or use `--local` to stay completely offline.

The `WHOBURNEDMORE_API` environment variable overrides the server endpoint, so you can point the CLI at a self-hosted instance.

> **Don't just take our word for it — get an independent second opinion.**
>
> ### 🔍 [Ask Claude to audit this repo before you run it →][audit]
>
> One click opens a fresh [Claude](https://claude.ai) chat pre-filled with a prompt that asks it to read this repository's source and report back exactly what data the CLI collects, what leaves your machine (and what never does), every server it talks to, and whether it could exfiltrate your code, prompts, secrets, or files — ending with a clear **go / no-go** verdict on whether it's safe to run.

---

## Background sync

Once installed, the background sync runs `npx whoburnedmore` every 15 minutes via a launchd job (macOS) or equivalent. The job:

- Resolves to the **latest published version** on each tick — no manual updates needed
- Is **self-healing**: if the plist drifts or the node path changes, the next `install-sync` call corrects it
- Reports freshness via `whoburnedmore status` and `whoburnedmore doctor`

```bash
npx whoburnedmore install-sync    # start background sync
npx whoburnedmore status          # check last-sync time and staleness
npx whoburnedmore uninstall-sync  # stop it
```

---

## Organizations and friend boards

```bash
# Compare with specific people
npx whoburnedmore --board=INVITE_CODE

# Submit to a company or hackathon board
npx whoburnedmore --org=your-org-slug
```

Organizations get a private leaderboard at `your-org.whoburnedmore.com`, a management dashboard, and per-member roles. Friend boards are private groups you invite people into with a short code.

---

## Build

```bash
npm install
npm run build   # bundles src/ -> dist/index.js
npm test
```

---

## Open source

This repository is the exact CLI published to npm — a public, always-in-sync mirror of the production code. It contains no secrets and no server-side code, only the client that reads your local logs and talks to the public API.

The server, leaderboard, and dashboard are at [whoburnedmore.com](https://whoburnedmore.com).

---

## License

MIT — see [LICENSE](LICENSE).

[audit]: https://claude.ai/new?q=Please%20audit%20this%20open-source%20CLI%20for%20safety%20before%20I%20run%20it%3A%20https%3A%2F%2Fgithub.com%2Farhxam%2Fwhoburnedmore.com%0A%0AIt%20is%20run%20with%20%22npx%20whoburnedmore%22%20and%20reads%20my%20local%20AI%20coding-agent%20usage%20(Claude%20Code%2C%20Codex%2C%20Cursor%2C%20and%20similar%20tools).%20Read%20the%20ACTUAL%20source%20code%20in%20the%20repository%20and%20tell%20me%20plainly%3A%0A%0A1.%20Exactly%20what%20data%20it%20collects%2C%20and%20precisely%20what%20leaves%20my%20machine%20versus%20what%20never%20does.%0A2.%20Every%20network%20endpoint%20or%20server%20it%20contacts.%0A3.%20Whether%20it%20could%20exfiltrate%20my%20source%20code%2C%20prompts%2C%20secrets%2C%20credentials%2C%20tokens%2C%20or%20files.%0A4.%20Any%20supply-chain%2C%20subprocess%2C%20or%20background%20%2F%20auto-update%20risks.%0A%0AThen%20give%20me%20a%20final%20go%20%2F%20no-go%20verdict%3A%20is%20it%20safe%20to%20run%2C%20and%20is%20it%20trying%20to%20steal%20any%20of%20my%20data%3F
