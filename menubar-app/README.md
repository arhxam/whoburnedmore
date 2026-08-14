# BurnBar

Native macOS menu bar app showing **live token burn + remaining usage limits**
across your AI coding tools — Claude Code, Codex, Cursor, Cline, Roo, Continue,
and the ccusage long tail — with an optional [whoburnedmore](https://whoburnedmore.com)
leaderboard context. Standalone-first: fully useful signed-out and offline.

Spec: `docs/superpowers/specs/2026-08-02-burnbar-design.md` ·
Plan: `docs/superpowers/plans/2026-08-02-burnbar-impl.md`

## Architecture

Two processes, one privacy rule — nothing sensitive crosses a boundary:

- **BurnBar.app** (Swift/SwiftUI `MenuBarExtra`, macOS 14+): UI, notifications,
  the Claude limits fetch (Keychain "Claude Code-credentials" → Anthropic's OAuth
  usage endpoint; the token lives in memory for one request, is never written
  anywhere, and is never refreshed — rotating it would break `claude`'s login),
  and the whoburnedmore strip (public `GET /v1/users/:handle`).
- **burnbar-sidecar** (TypeScript compiled to a bun single-file executable, in
  `Contents/Resources/`): reuses the whoburnedmore CLI's native readers
  (`src/native/*`) with their per-file parse caches, re-orchestrated
  because `collectAll`'s ccusage `require.resolve` cannot run inside a compiled
  binary. The ccusage long tail runs via the standalone `ccusage` platform binary
  (also in Resources). Codex rate limits are parsed straight from
  `$CODEX_HOME/sessions` rollout JSONL — no auth needed.

Real-time: the sidecar `watch` command puts `fs.watch` (FSEvents) recursively on
every tool's log root, debounces 1.5s, re-collects the native tier (warm cache =
sub-second) and emits events. A 5-second native safety poll covers missed
FSEvents, while a separate 1-second Codex-limit poll publishes cap/reset changes
without waiting for transcript aggregation. The ccusage/Cursor tier refreshes every 5 min.
Caches live in `~/.config/burnbar`, isolated from the CLI's launchd sync.

## Sidecar protocol

NDJSON on stdout, one event per line (`sidecar/src/protocol.ts` is the source of
truth): `hello`, `snapshot {summary}`, `limits {codex, cursor}`, `alert {kind,
provider, level, percent}` (80/95% rising edges + window resets), `status`,
`heartbeat`. Stdin accepts `{"cmd":"refresh"}` and `{"cmd":"quit"}`. Unknown
event types must be ignored by consumers. `Summary` includes `sessionsToday`
(today's top 5 sessions by tokens — `{name, tool, tokens}`, best-effort via the
ccusage `session` rollup). `Limits.cursor` is Cursor's plan usage
(`{present, planPercent, used, limit, renewsAt}`), fetched best-effort over the
network from the local Cursor session cookie — always `present: false` when
Cursor isn't installed/signed in or the endpoint fails.

Commands: `snapshot` / `limits` (one-shot JSON), `sync` (one-shot: collect +
submit to whoburnedmore using the CLI's stored sign-in; `--dry-run` prints row
counts instead of submitting; prints `{error:"not-connected"}` exit 3 if no CLI
token is configured), `watch` (stream), `version`.

## Build

Requires: Xcode 15+, [bun](https://bun.sh), [xcodegen](https://github.com/yonaskolb/XcodeGen),
pnpm workspace installed (`pnpm install` at repo root).

```bash
cd apps/menubar
bash scripts/build-app.sh      # sidecar + xcodebuild + assemble + Developer ID sign
bash scripts/make-dmg.sh       # dist/BurnBar.dmg
open dist/BurnBar.app
```

BurnBar uses Sparkle 2 for updates. It checks once per day by default, asks
before installing, and exposes automatic-install plus **Check for Updates…**
controls in General Settings. See `docs/runbooks/burnbar-release.md` for the
signed appcast and release procedure.

## Run & debug

- `BURNBAR_DEBUG_WINDOW=1` opens the popover content in a floating window
  (used by `scripts/debug-window-shot.sh` for screenshot verification).
- `BURNBAR_API_BASE` / `WHOBURNEDMORE_WEB` override the whoburnedmore endpoints;
  `BURNBAR_SIDECAR` / `BURNBAR_CCUSAGE` point at dev binaries;
  `BURNBAR_CACHE_DIR`, `BURNBAR_DEBOUNCE_MS`, `BURNBAR_NATIVE_POLL_MS`,
  `BURNBAR_LIMITS_POLL_MS`, and `BURNBAR_SLOW_INTERVAL_MS` tune the engine.
- `BURNBAR_CHECK_FOR_UPDATES_ON_LAUNCH=1` exercises Sparkle's foreground
  update-check path for release verification.
- Menu bar items are source-first (Overall / Claude / Codex / other providers),
  and only offer metrics that source can truthfully provide. Notification,
  Claude-limit, and launch-at-login permissions are explicit in Settings.

## Tests

```bash
npx vitest run --root sidecar        # protocol, summarize, codex limits,
                                     # forecast/thresholds, real-binary watch integration
bash scripts/run-swift-tests.sh      # BurnBarCore: formatters, meter states, decoders
```

## Verification scripts

`scripts/check-snapshot.sh` (real burn via compiled binary) ·
`scripts/check-claude-usage.sh` (live usage endpoint) ·
`scripts/check-codex-limits.sh` · `scripts/check-launch.sh` ·
`scripts/debug-window-shot.sh [--offline]`

## Distribution status

Developer ID signing, notarization, a stapled DMG, and Sparkle auto-update are
part of the release path. A Homebrew cask is not currently provided. BurnBar
performs its own opt-in live leaderboard sync through the sidecar while agents
are active, throttled to at most twice per minute. The CLI launchd job remains
a slower independent convergence path, not BurnBar's primary live path.

## First run & how BurnBar connects to whoburnedmore

**Minute one (no account needed):** download the DMG → drag to Applications →
open. BurnBar detects which AI tools have local logs (`~/.claude`, `~/.codex`,
Cursor's app storage, VS Code globalStorage, `~/.continue`) and starts the
sidecar's file watchers immediately — the flame + your chosen metrics appear in
the menu bar within seconds, all parsed on-device. The onboarding window shows
which tools were found and separately offers launch at login, notification
permission, and read-only Claude Code Keychain access for 5h/weekly limits.
Declining any of them leaves local burn tracking fully functional; Codex limits
come from local session files and need no additional permission.

**The whoburnedmore interconnect (all optional):**
1. *Already a CLI user?* BurnBar reads `~/.config/whoburnedmore/config.json` —
   the same file `npx whoburnedmore` writes — and the leaderboard context lights
   up with today's live top burners and the people around your daily rank. If
   you have not burned yet today, it shows the daily top five. Zero setup.
2. *New user?* Settings → Account → Connect runs the device flow against the
   real API (`POST /v1/auth/device` → browser approval → token polled), then
   writes the SAME config.json the CLI uses — app and CLI stay interchangeable,
   one sign-in for both.
3. *Getting ON the leaderboard:* the "Sync my usage" toggle (Settings → General)
   makes the app submit through the sidecar's `sync` command — the identical
   payload/endpoint the CLI's 15-minute launchd job uses (idempotent server
   upserts, so app + CLI coexisting is safe). Being *listed publicly* still
   follows the site's privacy gate: signed in AND ≥1 social handle on your
   profile; until then your data is private to you.
4. *Offline/site down:* only the leaderboard context greys out; limits, burn, forecasts
   and notifications are fully local and keep working.

"Tokens this session" counts burn observed while BurnBar is running within the
current 5-hour window (it can't see tokens burned while it wasn't running).
