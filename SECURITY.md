# Security

`whoburnedmore` is a CLI that runs on your machine, reads your local AI-agent usage,
and submits **daily aggregate numbers** to whoburnedmore.com. This document is the threat
model — what the tool does with untrusted input and how it's hardened — because you should
be able to verify it before running it.

## What leaves your machine
Only bounded aggregates: per day/tool/model token counts, estimated cost, and optional
session/tool/skill/project **names + counts**. Never your prompts, code, file contents, or
file paths. `--dry-run` prints the exact payload; `--local` uploads nothing at all.

## Threat model & mitigations
- **Server-controlled URLs.** The dashboard/board URL comes back from the server. The CLI
  **only auto-opens it if it is an `https` URL on the expected web host** (`isTrustedWebUrl`),
  and the OS opener is only ever handed an `http(s)`/`file` URL (`isOpenableUrl`). A
  malicious or MITM'd response cannot make the CLI launch `javascript:`/`file:`/custom-scheme
  URLs or inject `-`-prefixed flags into `open`. (Use HTTPS; the API host is pinned.)
- **Subprocess spawns.** `ccusage`, the browser opener, and the launchd/cron auto-sync are
  all spawned with **argument arrays (never a shell string)**; the `ccusage` arguments are
  fixed constants (no server/user data), and the scheduler entries embed only local paths.
- **Untrusted transcript input.** Malformed/huge transcript stores are bounded (file-count,
  per-file-size, and time budgets) so a pathological store cannot hang or OOM the CLI;
  duplicate rows are merged before submit.
- **Local secret.** The per-machine key lives in `~/.config/whoburnedmore/config.json` at
  mode `0600`, re-asserted on every write.
- **Local dashboard.** `--local` writes a self-contained HTML file; all user-derived values
  are HTML-escaped.
- **Supply chain.** Runtime dependencies are exact-pinned and audited.

## Reporting a vulnerability
Please report privately via **GitHub Security Advisories**
(<https://github.com/amiinwani/whoburnedmore.com/security/advisories/new>) rather than a
public issue. We aim to respond quickly.
