# Handoff: website and API

For the maintainer of [whoburnedmore.com](https://whoburnedmore.com) and
[api.whoburnedmore.com](https://api.whoburnedmore.com).

This repository is the CLI and BurnBar. The work below is not in this tree.
A CLI pull request cannot land it.

## Period toggle

The daily / weekly / all-time toggle lives only on the website. The CLI does
not have it.

The site already prefetches the other periods after first paint. It stores
those responses in a 30-second one-shot cache of at most about 6 entries. The
selected period is polled through SWR every 5 seconds, and that poll constantly
expires the one-shot cache. Each entry is consumed once and is never copied
into SWR's cache, so the next switch misses. Hover prefetch starts too late to
hide a request this slow.

Change the client as follows:

- Keep the prefetched periods in SWR with `preload` or `mutate`. Switching
  period should show the cached rows immediately and refresh behind them.
- Refresh the periods that are not selected about every 60 seconds, and only
  while the tab is visible.
- Abort an in-flight request only when the metric, tool, board, or sign-in
  changes, or on unmount. Do not abort it because a timer fired.
- Consider slowing the selected period's 5-second poll. It is what keeps
  expiring the prefetch.

## Leaderboard responses

Measured on 2026-11-03 from Cloudflare SIN:

`GET https://api.whoburnedmore.com/v1/leaderboard?by=tokens&period=<period>`

`cf-cache-status` was `DYNAMIC`. Responses had no `Cache-Control`.

- `period=today`: 13.6 s, then 1.4 s. Body 94 KB.
- `period=7d`: 9.7 s, then 1.2 s. A later sample took 24.8 s. Body 134 KB.
- `period=30d`: about 19.5 s. Body 162 KB.
- `period=all`: up to 24.1 s. Body 245 KB.

The website proxy `GET /api/leaderboard` sent
`Cache-Control: max-age=0, must-revalidate` and `x-vercel-cache: MISS`.

Change the server as follows:

- On signed-out leaderboard responses, send
  `Cache-Control: public, s-maxage=15, stale-while-revalidate=300`.
- Precompute the 7-day and all-time totals. Do not aggregate them on the
  request that paints the page.
- Include all three periods in the server-rendered page, so the first toggle
  does not wait on a cold query.

## Device-approval page

The "Access Dashboard" button is not in this repository. The button, together
with the CLI opening the profile, produced two tabs.

Replace that button with: "You're signed in. Return to your terminal."

A separate CLI pull request stops the CLI from auto-opening the dashboard for
returning users. That pull request does not change this page. The button still
has to go.
