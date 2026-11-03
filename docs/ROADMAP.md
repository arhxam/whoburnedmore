# Roadmap: 0.1 to 1,000

Direction from a small board toward about 1,000 people using it. No dates.
A line in this file is a direction. It is not a claim that the work has shipped.

## Trust

The total for a tool has to match that tool's own logs.

- Native readers for every agent we count.
- A correctness fixture per reader, so a parser change fails when the number
  is wrong.

## Zero friction

- Sign in once.
- A returning run does not prompt, and it does not open a browser.
- After `uninstall-sync`, background sync stays off.

The approval page the CLI sends you to is on the website. See
[handoff-web-server.md](handoff-web-server.md).

## Social and retention

- Friend boards and team boards.
- A weekly recap.
- Streaks.
- Shareable cards.
- In BurnBar, a period toggle and a live rank.

The daily / weekly / all-time toggle on the website, and the leaderboard
caching behind it, are not in this repo. Same note:
[handoff-web-server.md](handoff-web-server.md).

## Platform

- A Windows and Linux tray app. BurnBar today is macOS.
- An org admin view.
- A public API and badges.

## How to measure

- Time to first rank.
- The share of returning runs that sync with no prompt and no browser open.
- Sync success rate.
