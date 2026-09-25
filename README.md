# whoburnedmore

> Find out who burned more — submit your AI coding-agent token usage to the public
> leaderboard at [whoburnedmore.com](https://whoburnedmore.com).

```bash
npx whoburnedmore
```

**This is the real, production CLI** — the exact code published to npm and run on users'
machines. This repository is a public, always-in-sync mirror of it.

## What it does

`whoburnedmore` reads your local AI coding-agent usage (Claude Code, Codex, Gemini CLI,
Copilot, Cursor and more, via [ccusage](https://github.com/ryoppippi/ccusage)), adds up
the tokens and estimated cost, and **submits your daily totals to the whoburnedmore.com
server** so you land on the public leaderboard and get a shareable dashboard.

Your **first run signs you in** — the CLI opens a page and you approve a short code — then
binds this machine to your account so your usage lands on the leaderboard under your handle.
(Prefer to stay fully offline? `--local` never signs in and never uploads.)

### What leaves your machine

Only **daily aggregate numbers** — date, tool, model, token counts, and estimated cost
(plus optional per-session / per-tool rollups). **Never** your prompts, your code, file
contents, or file paths. Run `private` to drop off the board, `remove` to delete your
dashboard and its data, or use `--local` to stay fully offline.

> Want a 100%-local report that makes **no** network calls at all? Use `npx whoburnedmore
> --local`, which builds an HTML dashboard on your machine and uploads nothing.

## Commands

```
npx whoburnedmore                sign in, submit, land on the leaderboard, open your dashboard
npx whoburnedmore --board=CODE   compare with friends — sign in and join their board
npx whoburnedmore --org=SLUG     submit to your organization's board (companies/hackathons)
npx whoburnedmore --local        build the dashboard locally and open it (offline, no upload)
npx whoburnedmore --dry-run      print exactly what would be sent, send nothing
npx whoburnedmore --no-submit    collect locally, send nothing
npx whoburnedmore link --token=TOKEN  bind a server/VM to your account (token from your profile)
npx whoburnedmore daemon         keep syncing in the foreground (containers with no scheduler)
npx whoburnedmore private        hide your dashboard from the leaderboard
npx whoburnedmore public         put it back
npx whoburnedmore remove         delete your dashboard and its data
npx whoburnedmore verify         delisted? re-verify your usage to get back on
npx whoburnedmore status         check background-sync health (last sync, staleness)
npx whoburnedmore install-sync     turn on 15-minute background sync
npx whoburnedmore uninstall-sync   turn off the background sync
```

After your first run, a background sync keeps your page fresh automatically
every 15 minutes (`uninstall-sync` to stop). The installed background job runs
the exact CLI version that installed it, with npm lifecycle scripts disabled.
Run an updated CLI in the foreground to repair the job and advance its version;
background jobs do not automatically download a newer release. The server endpoint is
overridable with `WHOBURNEDMORE_API`.

On Windows, sync runs while you are signed in using a windowless Windows Script
Host launcher. It keeps your normal user/network access and writes output and exit
codes to `~/.config/whoburnedmore/sync.log` (or `WHOBURNEDMORE_CONFIG_DIR/sync.log`).
The log rotates to `sync.log.1` after 256 KiB. Windows Script Host and Windows
PowerShell must be available; managed machines may restrict them.

To repair an older Windows task that opens a console, run `whoburnedmore install-sync`
from an updated installation. `whoburnedmore status` reports stale definitions and
the last successful upload. If a run still fails, inspect `sync.log` or run
`whoburnedmore sync` in a terminal. A task result of `1` alone does not identify
whether npm, collection, authentication, or an upload failed. Setting the task's
`Hidden` property only hides it in Task Scheduler; changing its logon type to S4U
can restrict network/encrypted-file access and is not the windowless-sync fix.
Tasks explicitly disabled in Task Scheduler stay disabled during automatic repair;
`install-sync` explicitly enables them again.

## Privacy & transparency

This repository exists so you can read exactly what the CLI does before you run it. It
contains no secrets and no server code — just the client that talks to the public API.

## menubar-app/

[`menubar-app/`](./menubar-app/) is the source for **BurnBar**, a native macOS menu bar
app that shows live token burn and remaining usage limits across your AI coding tools. See
[`menubar-app/README.md`](./menubar-app/README.md) for its architecture and build steps.

## Build

```bash
npm install
npm run build   # bundles src/index.ts -> dist/index.js
npm test
```

## License

MIT
