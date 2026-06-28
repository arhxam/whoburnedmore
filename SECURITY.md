# Security

`whoburnedmore` is a CLI that runs on your machine, reads your local AI-agent usage,
and submits **daily aggregate numbers** to whoburnedmore.com. This document is the threat
model — what the tool does with untrusted input and how it's hardened — because you should
be able to verify it before running it.

## What leaves your machine
Only bounded aggregates: per day/tool/model token counts, estimated cost, and optional
session/tool/skill **names + counts**. Never your prompts, code, file contents, file paths,
project/repo names, or conversation titles. `--dry-run` prints the exact payload;
`--local` uploads nothing at all.

## Threat model & mitigations
- **Server-controlled URLs.** The dashboard/board URL comes back from the server. The CLI
  **only auto-opens it if it is an `https` URL on the expected web host** (`isTrustedWebUrl`),
  and the OS opener is only ever handed an `http(s)`/`file` URL (`isOpenableUrl`). A
  malicious or MITM'd response cannot make the CLI launch `javascript:`/`file:`/custom-scheme
  URLs or inject `-`-prefixed flags into `open`. (Use HTTPS; the API host is pinned.)
- **Subprocess spawns.** `ccusage`, the browser opener, and the auto-sync installers use
  fixed argv where the platform allows it. The scheduled sync command is
  `npm exec --yes --ignore-scripts --package whoburnedmore@latest -- whoburnedmore sync`:
  launchd values are XML-escaped, cron values are POSIX-quoted, and Windows task commands
  are quoted. The `ccusage` arguments are fixed constants (no server/user data).
- **Untrusted transcript input.** Malformed/huge transcript stores are bounded (file-count,
  per-file-size, and time budgets) so a pathological store cannot hang or OOM the CLI;
  duplicate rows are merged before submit.
- **Local secret.** The per-machine key lives in `~/.config/whoburnedmore/config.json` at
  mode `0600`, re-asserted on every write.
- **Local dashboard.** `--local` writes a self-contained HTML file; all user-derived values
  are HTML-escaped.
- **Bounded network.** Every server request has a 30s timeout, so a slow or unreachable
  server can never hang the CLI or the background sync indefinitely. All traffic is HTTPS
  to the pinned API host (overridable only via `WHOBURNEDMORE_API` for local dev).
- **Supply chain & auto-update.** Runtime dependencies are exact-pinned and audited. The
  optional background sync runs `npm exec --yes --ignore-scripts --package whoburnedmore@latest`
  every 15 minutes, so it always runs the latest published release — which means you are
  trusting the npm publishing pipeline of this package over time, not just the version you
  first installed. That pipeline is protected by npm 2FA + a scoped publish token; uninstall
  the sync (`whoburnedmore uninstall-sync`) or run `--local` if you'd rather not auto-update.

## Reporting a vulnerability
Please report privately via **GitHub Security Advisories**
(<https://github.com/amiinwani/whoburnedmore.com/security/advisories/new>) rather than a
public issue. We aim to respond quickly.
