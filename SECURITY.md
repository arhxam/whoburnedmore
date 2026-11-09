# Security

`whoburnedmore` is a CLI that runs on your machine, reads your local AI-agent usage,
and submits **daily aggregate numbers** to whoburnedmore.com. This document is the threat
model — what the tool does with untrusted input and how it's hardened — because you should
be able to verify it before running it.

## What leaves your machine

### Normal runs and background sync

The usage payload built in [`src/index.ts`](./src/index.ts) contains:

- Daily totals by date, tool and model: input/output/cache token counts, estimated USD
  cost, CLI origin/verification flags, and request counts when available.
- Optional time-window rollups (start time, token total and cost), tool/skill identifiers
  and counts (including error/token totals where available), aggregate message/token
  counts for main agents and subagents, and aggregate user-message counts.
- CLI version, local UTC offset, a hash of the bound machine key when available, and
  whether the tool/skill scan completed. Codex replay corrections may also include dates
  and prior per-model token totals.
- A board code, organization slug and organization join code when requested with the
  corresponding flags.

**Per-session rollups, session identifiers and project names are not uploaded.** The
shared schema still accepts an optional `sessions` field for compatibility, but the CLI
does not put it in the submission. Session parsing stays local. See the payload builder,
[`src/shared.ts`](./src/shared.ts) and [`src/wire-sanitize.ts`](./src/wire-sanitize.ts).

### Opt-in verification

`whoburnedmore verify` sends a different payload to the authenticated `/v1/verify`
endpoint. It reads local Claude Code logs and sends one record per deduplicated request:
local date, timestamp, tool (`claude`), model, input/output/cache token counts and a
truncated SHA-256 hash of the provider message/request identifiers. Raw identifiers are
not sent. The payload includes the CLI version, keeps at most the 50,000 most recent
requests, and marks a capped or incomplete scan as truncated.

The `verify` command starts this separate flow; a normal interactive sync can also offer
“Verify now?” for a suppressed account. In an interactive terminal verification asks
before sending. Background sync does not send this breakdown. See `runVerify` and
`submitSignedIn` in [`src/index.ts`](./src/index.ts) and
[`src/verify-upload.ts`](./src/verify-upload.ts).

Neither usage flow uploads prompts, code, file contents or file paths. Sign-in,
device binding and account-management commands have their own authentication requests;
the descriptions above cover the usage payloads.

### Previewing and staying offline

`--dry-run` prints the normal usage payload without submitting it; collection can still
fetch pricing or Cursor usage. It does not preview verification (`verify --dry-run` is
rejected). `--local` collects and renders an HTML dashboard offline, then may offer to
publish in an interactive terminal. Decline that default-no prompt to keep the run
offline. Accepting signs in and submits the normal usage payload.

## Threat model & mitigations
- **Server-controlled URLs.** The dashboard/board URL comes back from the server. The CLI
  **only auto-opens it if it is an `https` URL on the expected web host** (`isTrustedWebUrl`),
  and the OS opener is only ever handed an `http(s)`/`file` URL (`isOpenableUrl`). A
  malicious or MITM'd response cannot make the CLI launch `javascript:`/`file:`/custom-scheme
  URLs or inject `-`-prefixed flags into `open`. (Use HTTPS; the API host is pinned.)
- **Subprocess spawns.** `ccusage`, the browser opener, and the auto-sync installers use
  fixed argv where the platform allows it. The scheduled sync command is
  `npm exec --yes --ignore-scripts --package whoburnedmore@<installed-version> -- whoburnedmore sync`:
  launchd values are XML-escaped, cron values are POSIX-quoted, and Windows task commands
  are quoted. The `ccusage` arguments are fixed constants (no server/user data).
- **Untrusted transcript input.** Malformed/huge transcript stores are bounded (file-count,
  per-record-size (Claude), per-file-size (other readers), and time budgets) so a pathological store cannot hang or OOM the CLI;
  duplicate rows are merged before submit.
- **Local secret.** The per-machine key lives in `~/.config/whoburnedmore/config.json` at
  mode `0600`, re-asserted on every write.
- **Local dashboard.** `--local` writes a self-contained HTML file; all user-derived values
  are HTML-escaped.
- **Supply chain.** Runtime dependencies are exact-pinned and audited.

## Reporting a vulnerability
Please report privately via **GitHub Security Advisories**
(<https://github.com/arhxam/whoburnedmore/security/advisories/new>) rather than a
public issue. We aim to respond quickly.
